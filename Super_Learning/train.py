# ==============================
# BERT-Enhanced Influencer Detection Model (French)
# Uses CamemBERT embeddings + user metadata
# ==============================

import json
import numpy as np
import pandas as pd
from pandas import json_normalize
import torch
from transformers import AutoTokenizer, AutoModel
import gc
import os
import pickle

# User feature imports
import nltk
nltk.download('stopwords', quiet=True)

from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import StratifiedKFold, cross_val_score, train_test_split
import lightgbm as lgb

# ----------------------------
# 1. Load and flatten data
# ----------------------------
def load_and_flatten(file_path):
    df = pd.read_json(file_path, lines=True)
    return json_normalize(df.to_dict(orient='records'))

train_data = load_and_flatten('train.jsonl')
kaggle_data = load_and_flatten('kaggle_test.jsonl')

X_train = train_data.drop('label', axis=1)
y_train = train_data['label']
X_kaggle = kaggle_data.copy()

# ----------------------------
# 2. Extract full text
# ----------------------------
def extract_full_text(row):
    text = row.get('text', '')
    extended = row.get('extended_tweet.full_text', '')
    return extended if pd.notna(extended) and extended.strip() else text

X_train['full_text'] = X_train.apply(extract_full_text, axis=1)
X_kaggle['full_text'] = X_kaggle.apply(extract_full_text, axis=1)

# ----------------------------
# 3. Extract user features (same as before)
# ----------------------------
def extract_user_features(df):
    features = pd.DataFrame(index=df.index)
    

    def safe_get(col, default=0):
        if col in df.columns:
            s = df[col]
            if pd.api.types.is_numeric_dtype(s):
                return pd.to_numeric(s, errors='coerce').fillna(default)
            else:
                return s.fillna(default)
        else:
            return pd.Series([default] * len(df), index=df.index)

    numeric_cols = [
        'user.followers_count',
        'user.friends_count',
        'user.listed_count',
        'user.favourites_count',
        'user.statuses_count'
    ]
    for col in numeric_cols:
        raw = safe_get(col, default=0)

        raw = np.clip(raw, 0, None)
        features[col] = np.log1p(raw)
    
    features['user.verified'] = safe_get('user.verified', default=False).astype(bool).astype(int)
    features['has_url'] = (~safe_get('user.url', default='').astype(str).isin(['', 'nan'])).astype(int)
    features['has_location'] = (~safe_get('user.location', default='').astype(str).isin(['', 'nan'])).astype(int)
    features['default_profile'] = safe_get('user.default_profile', default=True).astype(bool).astype(int)
    
    if 'user.created_at' in df.columns:

        created_at = pd.to_datetime(
            df['user.created_at'],
            format='mixed',  
            errors='coerce'
        )
        now_utc = pd.Timestamp.now(tz='UTC')
        created_at_utc = created_at.dt.tz_localize(None).dt.tz_localize('UTC') 
        features['account_age_days'] = (now_utc - created_at_utc).dt.days.clip(lower=0).fillna(0)
    else:
        features['account_age_days'] = 0

    tweets_per_day = features['user.statuses_count'] / (features['account_age_days'] + 1)
    features['tweets_per_day'] = np.log1p(tweets_per_day)

    features['followers_to_friends'] = (
        (features['user.followers_count'] + 1) /
        (features['user.friends_count'] + 1)
    ).clip(0, 1e6)  

    features['listed_per_follower'] = (
        (features['user.listed_count'] + 1) /
        (features['user.followers_count'] + 1)
    ).clip(0, 1)

    desc = df['user.description'].fillna('').str.lower().astype(str)
    
    doctor_pattern = r'\b(?:médecin|docteur|doctor|md|health|santé|chirurgien|hospital)\b'
    features['is_doctor'] = desc.str.contains(doctor_pattern, regex=True, na=False).astype(int)
    
    journalist_pattern = r'\b(?:journaliste|reporter|correspondant|press|media|rédacteur|journal|tv|radio)\b'
    features['is_journalist'] = desc.str.contains(journalist_pattern, regex=True, na=False).astype(int)
    
    official_pattern = r'\b(?:gouv|gouvernement|ars|préfecture|santé publique|ministère|ofii|ameli|who|oms)\b|@(?:!me\b)(?:\w*gov|\w*ars|\w*sante)'
    features['is_official'] = desc.str.contains(official_pattern, regex=True, na=False).astype(int)

    return features

X_train_features = extract_user_features(X_train)
X_kaggle_features = extract_user_features(X_kaggle)

# ----------------------------
# 4. Generate CamemBERT Embeddings
# ----------------------------
print("Loading CamemBERT model...")

MODEL_NAME = "camembert-base"
tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
model = AutoModel.from_pretrained(MODEL_NAME)

# Use GPU if available
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"Using device: {device}")
if torch.cuda.is_available():
    print(f"GPU: {torch.cuda.get_device_name(0)}")
model.to(device)
model.eval()

def get_bert_embeddings(texts, batch_size=16):
    """Generate sentence-level embeddings using mean pooling. Uses mixed precision on GPU to reduce memory and avoid kernel issues."""
    all_embeddings = []
    total_batches = (len(texts) + batch_size - 1) // batch_size
    
    for i in range(0, len(texts), batch_size):
        batch_num = i // batch_size + 1
        print(f"Processing batch {batch_num}/{total_batches}...", end='\r')
        
        batch = texts[i:i+batch_size]
        inputs = tokenizer(
            batch,
            return_tensors="pt",
            padding=True,
            truncation=True,
            max_length=128
        ).to(device)

        with torch.no_grad():
            # Use autocast for mixed precision on GPU to lower memory/instability risk
            with torch.cuda.amp.autocast(enabled=(device.type == 'cuda')):
                outputs = model(**inputs)
                embeddings = outputs.last_hidden_state.mean(dim=1)
            all_embeddings.append(embeddings.float().cpu().numpy())
        
        # Optional: clear cache if on GPU
        if device.type == 'cuda':
            torch.cuda.empty_cache()
    
    print()  # New line after progress
    return np.vstack(all_embeddings)

# Get embeddings

bert_train_path = 'bert_train.npy'
bert_kaggle_path = 'bert_kaggle.npy'

print("Generating BERT embeddings for training set...")
if os.path.exists(bert_train_path):
    bert_train = np.load(bert_train_path)
else:
    bert_train = get_bert_embeddings(X_train['full_text'].fillna("").tolist())
    np.save(bert_train_path, bert_train)
    print(f"Saved training embeddings to {bert_train_path}")
print("Generating BERT embeddings for test set...")
if os.path.exists(bert_kaggle_path):
    bert_kaggle = np.load(bert_kaggle_path)
else:
    bert_kaggle = get_bert_embeddings(X_kaggle['full_text'].fillna("").tolist())
    np.save(bert_kaggle_path, bert_kaggle)
    print(f"Saved test embeddings to {bert_kaggle_path}")

# Convert to DataFrame for easy concat
bert_train_df = pd.DataFrame(bert_train, index=X_train.index, columns=[f"bert_{i}" for i in range(bert_train.shape[1])])
bert_kaggle_df = pd.DataFrame(bert_kaggle, index=X_kaggle.index, columns=[f"bert_{i}" for i in range(bert_kaggle.shape[1])])

# ----------------------------
# 4.5 Generate CamemBERT Embeddings for user.description
# ----------------------------
print("\nGenerating BERT embeddings for user descriptions...")
bert_desc_train_path = 'bert_desc_train.npy'
bert_desc_kaggle_path = 'bert_desc_kaggle.npy'

# Extract descriptions
desc_train = X_train.get('user.description', pd.Series([""] * len(X_train))).fillna("").tolist()
desc_kaggle = X_kaggle.get('user.description', pd.Series([""] * len(X_kaggle))).fillna("").tolist()

if os.path.exists(bert_desc_train_path) and os.path.exists(bert_desc_kaggle_path):
    print("Loading cached description embeddings...")
    bert_desc_train = np.load(bert_desc_train_path)
    bert_desc_kaggle = np.load(bert_desc_kaggle_path)
else:
    print("Processing training descriptions...")
    bert_desc_train = get_bert_embeddings(desc_train, batch_size=32)
    np.save(bert_desc_train_path, bert_desc_train)
    print(f"Saved training description embeddings to {bert_desc_train_path}")
    
    print("Processing test descriptions...")
    bert_desc_kaggle = get_bert_embeddings(desc_kaggle, batch_size=32)
    np.save(bert_desc_kaggle_path, bert_desc_kaggle)
    print(f"Saved test description embeddings to {bert_desc_kaggle_path}")

# Convert to DataFrame
bert_desc_train_df = pd.DataFrame(bert_desc_train, index=X_train.index, columns=[f"bert_desc_{i}" for i in range(bert_desc_train.shape[1])])
bert_desc_kaggle_df = pd.DataFrame(bert_desc_kaggle, index=X_kaggle.index, columns=[f"bert_desc_{i}" for i in range(bert_desc_kaggle.shape[1])])

# ----------------------------
# 5. Combine all features
# ----------------------------

X_train_final = pd.concat([X_train_features, bert_train_df, bert_desc_train_df], axis=1)
X_kaggle_final = pd.concat([X_kaggle_features, bert_kaggle_df, bert_desc_kaggle_df], axis=1)

# Scale numeric features
scaler = StandardScaler()
num_cols = ['user.followers_count', 'user.listed_count', 'user.statuses_count', 'account_age_days']
X_train_final[num_cols] = scaler.fit_transform(X_train_final[num_cols])
X_kaggle_final[num_cols] = scaler.transform(X_kaggle_final[num_cols])


X_train_split, X_val_split, y_train_split, y_val_split = train_test_split(
    X_train_final, y_train, test_size=0.1, random_state=42, stratify=y_train
)

print(f"Train: {len(X_train_split)}, Validation: {len(X_val_split)}")

# ----------------------------
# 6. Train LightGBM with Early Stopping + Hyperparameter Tuning
# ----------------------------
print("\nTraining optimized LightGBM with Early Stopping...")

lgb_model = lgb.LGBMClassifier(
    n_estimators=1500,
    max_depth=7,
    num_leaves=63,
    learning_rate=0.03,
    subsample=0.8,
    colsample_bytree=0.8,
    reg_alpha=0.1,
    reg_lambda=0.1,
    min_child_samples=50,
    random_state=42,
    verbose=-1,
    device='gpu' if torch.cuda.is_available() else 'cpu'
)

lgb_model.fit(
    X_train_split, y_train_split,
    eval_set=[(X_val_split, y_val_split)],
    eval_metric='binary_logloss',
    callbacks=[lgb.early_stopping(50), lgb.log_evaluation(0)]
)

train_score = lgb_model.score(X_train_split, y_train_split)
val_score = lgb_model.score(X_val_split, y_val_split)
print(f"\nLightGBM Performance:")
print(f"  Train Acc: {train_score*100:.2f}%")
print(f"  Val Acc: {val_score*100:.2f}%")
print(f"  Overfitting Gap: {(train_score - val_score)*100:.2f}%")

# Save model
with open('lgb_single_model.pkl', 'wb') as f:
    pickle.dump(lgb_model, f)
print("Models saved successfully")
# ----------------------------
# 7. Generate Predictions and Save Submission
# ----------------------------
print("\nGenerating final predictions on Kaggle test set...")
y_pred_proba = lgb_model.predict_proba(X_kaggle_final)[:, 1]
pred_labels = (y_pred_proba >= 0.5).astype(int)

submission = pd.DataFrame({
    'ID': X_kaggle['challenge_id'],
    'Prediction': y_pred_proba
})
submission.to_csv('result.csv', index=False)
print(f"Submission saved to 'result.csv' with {len(submission)} samples (0/1 labels)")

# Save scalers and preprocessing info
with open('scaler_final.pkl', 'wb') as f:
    pickle.dump(scaler, f)
print("Saved scaler for reproducibility")