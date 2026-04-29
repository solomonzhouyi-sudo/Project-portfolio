## Team Members
* Zhang Weihao (weihao.zhang@ip-paris.fr)
* Wang Yizheng (yizheng.wang@ip-paris.fr)
* Zhou Yiqian (yiqian.zhou@ip-paris.fr)

## Project Files
* `train.py`: The main script to train the LightGBM model and generate predictions.
* `dl_report.pdf`: Detailed project report.

## Prerequisites (Requirements)
To run `train.py`, please ensure you have the following Python libraries installed:
```bash
pip install pandas numpy scikit-learn lightgbm torch transformers nltk
```

## Data Setup (Crucial)

Please place the following two original data files in the **same directory** as `train.py`:

1. `train.jsonl`
2. `kaggle_test.jsonl`

**Note:** The data files are NOT included in this submission zip file.

## How to Run

1. Open a terminal in the project directory.

2. Run the training script:

   Bash

   ```
   python train.py
   ```

3. Output:

   - The script will extract features, generate BERT embeddings (using GPU if available), and train the LightGBM model.
   - The final prediction file will be saved as **`result.csv`**.