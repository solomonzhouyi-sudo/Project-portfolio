(function () {
  /* ---------- Page enter ---------- */
  requestAnimationFrame(() => document.body.classList.add("ready"));

  /* ---------- Back navigation (to index) ---------- */
  document.getElementById("back-to-index").addEventListener("click", () => {
    document.body.classList.add("page-exit");
    setTimeout(() => (location.href = "../index.html"), 420);
  });

  /* ---------- Paths ---------- */
  const MEDALS_CSV = "../data/medals_total.csv";
  const WORLD_TOPOJSON = "../data/countries-110m.json";
  const DETAIL_MEDALS_CSV = "../data/medals.csv";
  /* ---------- Elements ---------- */
  const svg = d3.select("#map-svg");
  const rankBody = document.getElementById("rank-body");

  const searchInput = document.getElementById("country-search");
  const clearSearchBtn = document.getElementById("clear-search");

  const viewBoard = document.getElementById("view-board");
  const viewDetail = document.getElementById("view-detail");

  const statGold = document.getElementById("stat-gold");
  const statSilver = document.getElementById("stat-silver");
  const statBronze = document.getElementById("stat-bronze");
  const statTotal = document.getElementById("stat-total");
  const detailTitle = document.getElementById("detail-title");
  const detailSubtitle = document.getElementById("detail-subtitle");

  /* ---------- Helpers ---------- */
  const toInt = (v) => +String(v ?? 0).replace(/,/g, "") || 0;
  const norm = (s) =>
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ");

  /* ---------- Alias mapping (map topojson name -> medals country_long) ---------- */
  const NAME_ALIASES = new Map([
    // China variants
    ["china", "people's republic of china"],
    ["people's republic of china", "people's republic of china"],
    ["pr china", "people's republic of china"],

    // Taiwan / Chinese Taipei variants (FIX)
    ["taiwan", "chinese taipei"],
    ["chinese taipei", "chinese taipei"],
    ["taiwan (province of china)", "chinese taipei"],
    ["chinese taipei (taiwan)", "chinese taipei"],
    ["republic of china", "chinese taipei"],

    // Hong Kong / Macau (optional but useful)
    ["hong kong", "hong kong, china"],
    ["hong kong, china", "hong kong, china"],
    ["macao", "macau, china"],
    ["macau", "macau, china"],
    ["macau, china", "macau, china"],

    // USA variants
    ["united states", "united states of america"],
    ["usa", "united states of america"],
    ["u.s.", "united states of america"],
    ["united states of america", "united states of america"],

    // UK variants
    ["united kingdom", "great britain"],
    ["great britain", "great britain"],

    // Russia / Iran / Korea common naming issues
    ["russia", "russian federation"],
    ["iran", "islamic republic of iran"],
    ["korea", "republic of korea"],
    ["south korea", "republic of korea"],
    ["north korea", "democratic people's republic of korea"],

    // Czechia / Turkey / Vietnam
    ["czechia", "czech republic"],
    ["turkey", "türkiye"],
    ["viet nam", "vietnam"],
  ]);

  function canonicalMedalsKeyFromMapName(mapName) {
    const k = norm(mapName);
    return norm(NAME_ALIASES.get(k) || k);
  }

  /* ---------- Color scale (single hue) ---------- */
  function makeSingleHueScale(maxTotal) {
    const low = d3.color("#EAE3FF");
    const high = d3.color("#2D1B69");
    return d3
      .scaleSqrt()
      .domain([0, maxTotal || 1])
      .range([low.formatHex(), high.formatHex()])
      .clamp(true);
  }

  /* ---------- State ---------- */
  let medalsAll = [];            // full list
  let medalsByKey = new Map();   // key=country_long normalized -> record
  let maxTotal = 0;

  // map rendering state
  let projection = null;
  let path = null;
  let geoFeatures = null;
  let g = null;
  let countriesSel = null;

  let activeKey = null;          // currently selected normalized key (country_long)
  let tooltip = null;

  /* ---------- Load data ---------- */
  Promise.all([
    d3.json(WORLD_TOPOJSON),
    d3.csv(MEDALS_CSV),
    d3.csv(DETAIL_MEDALS_CSV)
  ]).then(([world, totals, detailMedals]) => {
    // 保存详细奖牌数据到全局变量
    window.allMedalDetails = detailMedals;
    
    // 处理总奖牌数据
    medalsAll = totals
      .map((r) => ({
        country: r.country,
        country_long: r.country_long,
        gold: toInt(r["Gold Medal"]),
        silver: toInt(r["Silver Medal"]),
        bronze: toInt(r["Bronze Medal"]),
        total: toInt(r["Total"]),
      }))
      .sort((a, b) => b.total - a.total || b.gold - a.gold);

    maxTotal = d3.max(medalsAll, (d) => d.total) || 0;
    medalsByKey = new Map(medalsAll.map((d) => [norm(d.country_long), d]));
    
    renderLeaderboard(medalsAll); // initial table
    renderMap(world);             // draw map
    hookSearch();                 // enable search
  })
  .catch((err) => {
    console.error(err);
    alert("Failed to load medals_total.csv or countries-110m.json. Check paths.");
  });

  /* ---------- Search ---------- */
  function hookSearch() {
    function applyFilter() {
      const q = norm(searchInput.value);
      if (!q) {
        renderLeaderboard(medalsAll);
        return;
      }
      const filtered = medalsAll.filter(
        (d) => norm(d.country).includes(q) || norm(d.country_long).includes(q)
      );
      renderLeaderboard(filtered);
    }

    searchInput.addEventListener("input", applyFilter);

    clearSearchBtn.addEventListener("click", () => {
      searchInput.value = "";
      renderLeaderboard(medalsAll);
      searchInput.focus();
    });

    // Enter: zoom/highlight first match without opening detail
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const q = norm(searchInput.value);
        if (!q) return;
        const first = medalsAll.find(
          (d) => norm(d.country).includes(q) || norm(d.country_long).includes(q)
        );
        if (first) {
          selectCountryByRecord(first, { openDetail: false, zoom: true });

          // scroll to row if present
          const row = rankBody.querySelector(`tr[data-key="${norm(first.country_long)}"]`);
          if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    });
  }

  /* ---------- Tooltip helpers (shared by map and leaderboard) ---------- */
  let showTip, hideTip;
  function initTooltip() {
    if (tooltip) return; // already initialized
    tooltip = d3.select("body").append("div").attr("class", "tooltip");
    showTip = (x, y, title, sub) => {
      // 获取视口尺寸，确保tooltip不超出屏幕
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = x + 15;
      let top = y + 15;
      
      // 简单的边界检查
      if (left + 280 > vw) left = x - 290;
      if (top + 100 > vh) top = y - 80;
      
      tooltip
        .style("left", left + "px")
        .style("top", top + "px")
        .html(`<div class="t-title">${title}</div><div class="t-sub">${sub}</div>`)
        .classed("show", true);
    };
    hideTip = () => tooltip.classed("show", false);
  }
  // Initialize tooltip early so leaderboard can use it
  initTooltip();

  /* ---------- Leaderboard ---------- */
  function renderLeaderboard(data) {
    rankBody.innerHTML = "";

    data.forEach((d, i) => {
      const tr = document.createElement("tr");
      const key = norm(d.country_long);
      tr.dataset.key = key;

      if (activeKey && key === activeKey) tr.classList.add("active");

      // Rank cell
      const rankTd = document.createElement("td");
      if (i < 3) {
        const img = document.createElement("img");
        img.src = `../assets/rank${i + 1}.svg`;
        img.style.width = "18px";
        img.style.height = "18px";
        rankTd.appendChild(img);
      } else {
        rankTd.textContent = i + 1;
      }
      tr.appendChild(rankTd);

      tr.appendChild(td(d.country));
      tr.appendChild(td(d.gold, "center"));
      tr.appendChild(td(d.silver, "center"));
      tr.appendChild(td(d.bronze, "center"));
      tr.appendChild(td(d.total, "right"));

      // Hover tooltip for leaderboard rows
      tr.addEventListener("mouseenter", (event) => {
        const sub = `🥇 ${d.gold}  🥈 ${d.silver}  🥉 ${d.bronze}  • Total ${d.total}`;
        showTip(event.clientX, event.clientY, d.country_long || d.country, sub);
      });
      tr.addEventListener("mousemove", (event) => {
        const sub = `🥇 ${d.gold}  🥈 ${d.silver}  🥉 ${d.bronze}  • Total ${d.total}`;
        showTip(event.clientX, event.clientY, d.country_long || d.country, sub);
      });
      tr.addEventListener("mouseleave", () => {
        hideTip();
      });

      tr.addEventListener("click", () => {
        selectCountryByRecord(d, { openDetail: true, zoom: true });
      });

      rankBody.appendChild(tr);
    });
  }

  function td(v, align) {
    const cell = document.createElement("td");
    cell.textContent = v;
    if (align) cell.style.textAlign = align;
    return cell;
  }

  function refreshTableActiveRow() {
    const rows = rankBody.querySelectorAll("tr");
    rows.forEach((r) => {
      r.classList.toggle("active", !!activeKey && r.dataset.key === activeKey);
    });
  }

  /* ---------- Map ---------- */
  function renderMap(world) {
    const geo = topojson.feature(world, world.objects.countries);
    geoFeatures = geo.features;

    const box = document.querySelector(".map-shell").getBoundingClientRect();
    const w = box.width;
    const h = box.height;

    projection = d3
      .geoNaturalEarth1()
      .fitExtent([[20, 20], [w - 20, h - 20]], geo);

    path = d3.geoPath(projection);

    const fillScale = makeSingleHueScale(maxTotal);

    svg.attr("viewBox", `0 0 ${w} ${h}`);
    svg.selectAll("*").remove();

    // defs for glow
    const defs = svg.append("defs");
    const filter = defs.append("filter").attr("id", "glow");
    filter.append("feGaussianBlur").attr("stdDeviation", "2.6").attr("result", "coloredBlur");
    const merge = filter.append("feMerge");
    merge.append("feMergeNode").attr("in", "coloredBlur");
    merge.append("feMergeNode").attr("in", "SourceGraphic");

    // Ensure tooltip is initialized (shared with leaderboard)
    initTooltip();

    // group for zoom/pan
    g = svg.append("g").attr("class", "map-layer");

    countriesSel = g
      .selectAll("path")
      .data(geoFeatures)
      .join("path")
      .attr("class", "country")
      .attr("d", path)
      .attr("fill", (f) => {
        const mapName = f.properties?.name || "";
        const key = canonicalMedalsKeyFromMapName(mapName);
        const rec = medalsByKey.get(key);
        return rec ? fillScale(rec.total) : "rgba(220,208,255,0.10)";
      })
      .on("mousemove", function (event, f) {
        const mapName = f.properties?.name || "Unknown";
        const key = canonicalMedalsKeyFromMapName(mapName);
        const rec = medalsByKey.get(key);
        const sub = rec
          ? `🥇 ${rec.gold}  🥈 ${rec.silver}  🥉 ${rec.bronze}  • Total ${rec.total}`
          : "No medal data";
        showTip(event.clientX, event.clientY, mapName, sub);
        d3.select(this).classed("hover", true);
      })
      .on("mouseleave", function () {
        hideTip();
        d3.select(this).classed("hover", false);
      })
      .on("click", function (_, f) {
        const mapName = f.properties?.name || "";
        const key = canonicalMedalsKeyFromMapName(mapName);
        const rec = medalsByKey.get(key);
        if (rec) selectCountryByRecord(rec, { openDetail: true, zoom: true });
      });

    // Apply current active selection if exists
    if (activeKey) applyActiveOnMap(activeKey);
  }

  function applyActiveOnMap(key) {
    if (!countriesSel) return;
    countriesSel
      .classed("active", (f) => {
        const mapName = f.properties?.name || "";
        const k = canonicalMedalsKeyFromMapName(mapName);
        return k === key;
      })
      .attr("filter", (f) => {
        const mapName = f.properties?.name || "";
        const k = canonicalMedalsKeyFromMapName(mapName);
        return k === key ? "url(#glow)" : null;
      });
  }

  /* ---------- Selection + Zoom ---------- */
  function selectCountryByRecord(rec, { openDetail, zoom }) {
    activeKey = norm(rec.country_long);

    refreshTableActiveRow();
    applyActiveOnMap(activeKey);

    if (zoom) zoomToKey(activeKey);
    if (openDetail) openDetailPanel(rec);
  }

  function zoomToKey(key) {
    if (!g || !path || !geoFeatures) return;

    const box = document.querySelector(".map-shell").getBoundingClientRect();
    const w = box.width;
    const h = box.height;

    const target = geoFeatures.find((f) => {
      const mapName = f.properties?.name || "";
      return canonicalMedalsKeyFromMapName(mapName) === key;
    });
    if (!target) return;

    const [[x0, y0], [x1, y1]] = path.bounds(target);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;

    const padding = 0.12;
    const scale = Math.max(1, Math.min(7, (1 - padding) / Math.max(dx / w, dy / h)));
    const tx = w / 2 - scale * cx;
    const ty = h / 2 - scale * cy;

    g.transition()
      .duration(800)
      .ease(d3.easeCubicInOut)
      .attr("transform", `translate(${tx},${ty}) scale(${scale})`);
  }

  /* ---------- Reset to world view (FIX for back-to-leaderboard) ---------- */
  function resetWorldView() {
    // reset zoom/pan
    if (g) {
      g.transition()
        .duration(700)
        .ease(d3.easeCubicInOut)
        .attr("transform", "translate(0,0) scale(1)");
    }

    // clear active
    activeKey = null;

    // clear map highlight
    if (countriesSel) {
      countriesSel.classed("active", false).attr("filter", null);
    }

    // clear table highlight
    refreshTableActiveRow();
  }
function renderMedalTimeline(data) {
    const container = d3.select("#timeline-svg-wrapper");
    container.selectAll("*").remove(); // 清空旧图

    if (data.length === 0) return;

    // 按日期和项目分组，以便处理同一天同一项目的多个奖牌
    const groupedData = d3.group(data, 
      d => `${d.medal_date}_${d.discipline}`
    );
    
    // 转换为数组，每组包含该组的所有奖牌
    const medalGroups = Array.from(groupedData.values());
    
    // 计算每个项目的最大奖牌数，用于动态调整宽度
    const disciplines = Array.from(new Set(data.map(d => d.discipline)));
    const disciplineMaxMedals = new Map();
    
    disciplines.forEach(disc => {
      const discData = data.filter(d => d.discipline === disc);
      const discGroups = d3.group(discData, d => d.medal_date);
      const maxInDay = Math.max(...Array.from(discGroups.values()).map(g => g.length));
      disciplineMaxMedals.set(disc, maxInDay);
    });
    
    const disciplineCount = disciplines.length;
    
    // 根据数据量动态计算宽度 - 因为奖牌更紧凑，可以减小宽度倍数
    const baseItemWidth = 50;  // 从55减小到50
    const disciplineWidths = new Map();
    disciplines.forEach(disc => {
      const maxMedals = disciplineMaxMedals.get(disc) || 1;
      // 奖牌更紧凑后，不需要那么大的宽度倍数
      const widthMultiplier = maxMedals <= 1 ? 1 : (maxMedals <= 2 ? 1.2 : (maxMedals <= 4 ? 1.3 : 1.4));
      disciplineWidths.set(disc, baseItemWidth * widthMultiplier);
    });
    
    const totalWidth = Array.from(disciplineWidths.values()).reduce((a, b) => a + b, 0);
    
    // 根据日期范围计算高度 - 进一步增加每天的高度以增加日期间距
    const dateRange = d3.extent(data, d => new Date(d.medal_date));
    const daySpan = (dateRange[1] - dateRange[0]) / (1000 * 60 * 60 * 24);
    const minHeight = Math.max(500, daySpan * 30); // 从25px增加到30px，进一步增加日期间距
    
    const margin = { top: 30, right: 30, bottom: 80, left: 80 };
    const width = totalWidth;
    const height = minHeight - margin.top - margin.bottom;

    const svg = container.append("svg")
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    // Y轴比例尺 (日期) - 纵向，反转范围让时间从下到上递增
    const y = d3.scaleTime()
        .domain(dateRange)
        .range([height, 0]);  // 反转：从height到0，这样最早的日期在底部

    // X轴比例尺 (项目) - 横向，使用自定义位置
    let currentX = 0;
    const xPositions = new Map();
    disciplines.forEach(disc => {
      const w = disciplineWidths.get(disc);
      xPositions.set(disc, currentX + w / 2);
      currentX += w;
    });

    // 绘制Y轴 (日期) - 显示所有日期
    // 获取所有唯一日期
    const uniqueDates = Array.from(new Set(data.map(d => d.medal_date)))
      .sort()
      .map(d => new Date(d));
    
    const yAxis = svg.append("g")
        .call(d3.axisLeft(y).tickValues(uniqueDates).tickFormat(d3.timeFormat("%m/%d")))
        .style("color", "rgba(255,255,255,0.6)");
    
    // 统一文字样式
    yAxis.selectAll("text")
        .attr("fill", "rgba(255,255,255,0.7)")
        .style("font-family", "'Montserrat', sans-serif")
        .style("font-size", "0.7rem");  // 从0.8rem减小到0.7rem
    
    yAxis.selectAll("line")
        .attr("stroke", "rgba(255,255,255,0.15)");
    
    yAxis.select(".domain")
        .attr("stroke", "rgba(255,255,255,0.2)");

    // 绘制X轴 (项目) - 横向，减小字体大小
    const xAxis = svg.append("g")
        .attr("transform", `translate(0,${height})`);
    
    disciplines.forEach(disc => {
      const xPos = xPositions.get(disc);
      
      // 绘制刻度线
      xAxis.append("line")
        .attr("x1", xPos)
        .attr("x2", xPos)
        .attr("y1", 0)
        .attr("y2", 6)
        .attr("stroke", "rgba(255,255,255,0.15)");
      
      // 绘制文字 - 减小字体并调整角度
      xAxis.append("text")
        .attr("x", xPos)
        .attr("y", 10)
        .attr("dy", "0.71em")
        .attr("text-anchor", "end")
        .attr("fill", "rgba(255,255,255,0.85)")
        .style("font-family", "'Montserrat', sans-serif")
        .style("font-size", "0.65rem")
        .style("font-weight", "400")
        .attr("transform", `rotate(-45, ${xPos}, 10)`)
        .text(disc);
    });
    
    // X轴主线
    xAxis.append("line")
      .attr("x1", 0)
      .attr("x2", width)
      .attr("y1", 0)
      .attr("y2", 0)
      .attr("stroke", "rgba(255,255,255,0.2)");

    // 创建tooltip提示框的辅助函数
    const showTimelineTip = (event, d) => {
      if (!tooltip) return;
      const medalIcon = d.medal_type.includes("Gold") ? "🥇" : 
                       d.medal_type.includes("Silver") ? "🥈" : "🥉";
      
      // 获取视口尺寸
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = event.clientX + 15;
      let top = event.clientY + 15;
      
      // 边界检查
      if (left + 280 > vw) left = event.clientX - 290;
      if (top + 100 > vh) top = event.clientY - 80;
      
      tooltip
        .style("left", left + "px")
        .style("top", top + "px")
        .html(`<div class="t-title">${medalIcon} ${d.name || 'Athlete'}</div><div class="t-sub">${d.event || d.discipline}<br/>${d.medal_date}</div>`)
        .classed("show", true);
    };

    const hideTimelineTip = () => {
      if (tooltip) tooltip.classed("show", false);
    };

    // 计算每组奖牌的布局位置（横向分组）- 紧凑布局，3个以上显著缩小
    function calculateGroupLayout(medals, baseX, baseY, availableWidth) {
      const count = medals.length;
      const positions = [];
      
      if (count === 1) {
        // 单个奖牌：居中
        positions.push({ x: baseX, y: baseY, r: 6 });
      } else if (count === 2) {
        // 2个奖牌：横向排列
        const spacing = 11;
        positions.push({ x: baseX - spacing/2, y: baseY, r: 5 });
        positions.push({ x: baseX + spacing/2, y: baseY, r: 5 });
      } else if (count === 3) {
        // 3个奖牌：紧凑三角形布局 - 缩小圆点
        const spacingX = 8;
        const spacingY = 7;
        positions.push({ x: baseX - spacingX/2, y: baseY - spacingY/2, r: 4 });  // 左上
        positions.push({ x: baseX + spacingX/2, y: baseY - spacingY/2, r: 4 });  // 右上
        positions.push({ x: baseX, y: baseY + spacingY/2, r: 4 });  // 底部居中
      } else if (count === 4) {
        // 4个奖牌：紧凑2x2网格 - 缩小圆点和间距
        const spacing = 5.5;  // 从7减小到5.5
        positions.push({ x: baseX - spacing, y: baseY - spacing, r: 3.5 });
        positions.push({ x: baseX + spacing, y: baseY - spacing, r: 3.5 });
        positions.push({ x: baseX - spacing, y: baseY + spacing, r: 3.5 });
        positions.push({ x: baseX + spacing, y: baseY + spacing, r: 3.5 });
      } else if (count === 5) {
        // 5个奖牌：紧凑布局 - 进一步缩小
        const spacing = 6;
        positions.push({ x: baseX - spacing, y: baseY - spacing, r: 3 });
        positions.push({ x: baseX + spacing, y: baseY - spacing, r: 3 });
        positions.push({ x: baseX - spacing, y: baseY + spacing, r: 3 });
        positions.push({ x: baseX + spacing, y: baseY + spacing, r: 3 });
        positions.push({ x: baseX, y: baseY, r: 3 });  // 中心
      } else if (count === 6) {
        // 6个奖牌：3x2网格
        const spacingX = 6;
        const spacingY = 6;
        positions.push({ x: baseX - spacingX, y: baseY - spacingY, r: 3 });
        positions.push({ x: baseX, y: baseY - spacingY, r: 3 });
        positions.push({ x: baseX + spacingX, y: baseY - spacingY, r: 3 });
        positions.push({ x: baseX - spacingX, y: baseY + spacingY, r: 3 });
        positions.push({ x: baseX, y: baseY + spacingY, r: 3 });
        positions.push({ x: baseX + spacingX, y: baseY + spacingY, r: 3 });
      } else {
        // 7个或更多：紧密网格 - 最小圆点
        const cols = 3;
        const rows = Math.ceil(count / cols);
        const spacingX = 5;
        const spacingY = 5;
        const startX = baseX - spacingX;
        const startY = baseY - ((rows - 1) * spacingY) / 2;
        
        for (let i = 0; i < count; i++) {
          const row = Math.floor(i / cols);
          const col = i % cols;
          positions.push({ 
            x: startX + col * spacingX, 
            y: startY + row * spacingY, 
            r: 2.5 
          });
        }
      }
      
      return positions;
    }

    // 绘制奖牌点 - 支持同组多个奖牌
    medalGroups.forEach(medals => {
      const firstMedal = medals[0];
      const baseX = xPositions.get(firstMedal.discipline);
      const baseY = y(new Date(firstMedal.medal_date));
      const availableWidth = disciplineWidths.get(firstMedal.discipline);
      
      const positions = calculateGroupLayout(medals, baseX, baseY, availableWidth);
      
      medals.forEach((medal, idx) => {
        const pos = positions[idx];
        
        svg.append("circle")
          .datum(medal)
          .attr("class", "timeline-dot")
          .attr("cx", pos.x)
          .attr("cy", pos.y)
          .attr("r", pos.r)
          .attr("fill", () => {
            if (medal.medal_type.includes("Gold")) return "#FFD700";
            if (medal.medal_type.includes("Silver")) return "#C0C0C0";
            return "#CD7F32";
          })
          .attr("stroke", "#fff")
          .attr("stroke-width", 1)
          .style("cursor", "pointer")
          .on("mousemove", (event) => showTimelineTip(event, medal))
          .on("mouseleave", hideTimelineTip)
          .on("mouseenter", function() {
            // 根据圆点大小动态调整hover增量
            const hoverIncrease = pos.r >= 5 ? 2 : (pos.r >= 4 ? 1.5 : 1);
            d3.select(this).attr("r", pos.r + hoverIncrease);
          })
          .on("mouseleave", function() {
            d3.select(this).attr("r", pos.r);
            hideTimelineTip();
          });
      });
    });
}
  /* ---------- Detail panel ---------- */
  function openDetailPanel(d) {
    detailTitle.textContent = d.country;
    detailSubtitle.textContent = `Total medals: ${d.total}`;
    statGold.textContent = d.gold;
    statSilver.textContent = d.silver;
    statBronze.textContent = d.bronze;
    statTotal.textContent = d.total;
    
    const countryDetails = window.allMedalDetails.filter(m => 
      m.country === d.country || m.country_code === d.country
    );
    
    renderMedalTimeline(countryDetails);
    
    viewBoard.classList.add("hidden");
    viewDetail.classList.remove("hidden");
    
    requestAnimationFrame(() => {
      document.querySelector(".layout").classList.add("detail-active");
    });
  }

  document.getElementById("back-to-board").onclick = () => {

    document.querySelector(".layout").classList.remove("detail-active");

    setTimeout(() => {
      viewDetail.classList.add("hidden");
      viewBoard.classList.remove("hidden");
      resetWorldView(); // ✅ back to full world map + clear highlight
    }, 300);
  };
})();