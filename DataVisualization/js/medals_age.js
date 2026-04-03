(function () {
  // -----------------------------
  // Smooth screen snapping (wheel)
  // -----------------------------
  const root = document.getElementById("snap-root");
  const screenMap = document.getElementById("screen-map");
  const screenAge = document.getElementById("screen-age");
  const cue = document.getElementById("scroll-cue");

  const btnBackToMap = document.getElementById("age-back-to-map");
  if (btnBackToMap) {
    btnBackToMap.addEventListener("click", () => {
      smoothScrollTo(screenMap);
    });
  }

  // Hide cue when user is on age screen
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.target === screenAge) {
          if (cue) cue.style.opacity = e.isIntersecting ? "0" : "0.9";
        }
      }
    },
    { threshold: 0.55 }
  );
  io.observe(screenAge);

  let wheelLock = false;
  root.addEventListener(
    "wheel",
    (e) => {
      const t = e.target;
      const inScrollable = closestScrollable(t);
      if (inScrollable) return;

      if (wheelLock) return;

      const goingDown = e.deltaY > 0;
      const top = root.scrollTop;
      const h = screenMap.getBoundingClientRect().height + 18;

      if (goingDown && top < 12) {
        e.preventDefault();
        wheelLock = true;
        smoothScrollTo(screenAge, () => (wheelLock = false));
        return;
      }

      if (!goingDown && top > h - 30) {
        e.preventDefault();
        wheelLock = true;
        smoothScrollTo(screenMap, () => (wheelLock = false));
        return;
      }
    },
    { passive: false }
  );

  function closestScrollable(el) {
    let cur = el;
    while (cur && cur !== document.body) {
      const style = window.getComputedStyle(cur);
      const overflowY = style.overflowY;
      if ((overflowY === "auto" || overflowY === "scroll") && cur.scrollHeight > cur.clientHeight + 2) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function smoothScrollTo(targetEl, done) {
    const start = root.scrollTop;
    const target = targetEl.offsetTop - 72;
    const dur = 820;
    const t0 = performance.now();

    function easeInOut(t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    function tick(now) {
      const p = Math.min(1, (now - t0) / dur);
      const v = start + (target - start) * easeInOut(p);
      root.scrollTop = v;
      if (p < 1) requestAnimationFrame(tick);
      else if (done) done();
    }

    requestAnimationFrame(tick);
  }

  // -----------------------------
  // Data + Age computation
  // -----------------------------
  const ATH = "../data/athletes.csv";
  const MEDALS = "../data/medals.csv";
  const MEDALLISTS = "../data/medallists.csv";
  const REF_DATE = new Date("2025-01-18T00:00:00");

  const parseDate = d3.timeParse("%Y-%m-%d");

  const norm = (s) =>
    String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ");

  function ageOnRef(birthStr) {
    const d = parseDate(birthStr);
    if (!d) return null;
    const ms = REF_DATE - d;
    return ms / (365.25 * 24 * 3600 * 1000);
  }

  function parsePyList(str) {
    if (!str) return [];
    const s = String(str).trim();
    if (!s.startsWith("[") || !s.endsWith("]")) return [s];
    try {
      const jsonish = s.replace(/'/g, '"');
      return JSON.parse(jsonish);
    } catch (e) {
      return s
        .slice(1, -1)
        .split(",")
        .map((x) => x.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    }
  }

  // Load all three data files
  Promise.all([d3.csv(ATH), d3.csv(MEDALS), d3.csv(MEDALLISTS)]).then(([ath, medals, medallists]) => {
    // Use medallists.csv for athlete codes (includes team sport members)
    const medalCodes = new Set();
    for (const m of medallists) {
      const code = String(m.code_athlete || "").trim();
      if (code) medalCodes.add(code);
    }
    
    console.log(`Total medallist codes: ${medalCodes.size}`);

    // explode athletes by discipline (one row per athlete-discipline)
    const athletesExploded = [];
    for (const a of ath) {
      const age = ageOnRef(a.birth_date);
      if (age == null || !isFinite(age)) continue;

      const gender = norm(a.gender);
      if (gender !== "male" && gender !== "female") continue;

      const disciplines = parsePyList(a.disciplines);
      if (!disciplines.length) continue;

      const isMedallist = medalCodes.has(String(a.code || "").trim());
      for (const d of disciplines) {
        athletesExploded.push({
          code: String(a.code || "").trim(),
          gender,
          discipline: String(d || "").trim(),
          age,
          isMedallist
        });
      }
    }

    // pick top disciplines by participants
    const byDisc = d3.rollups(
      athletesExploded,
      (v) => v.length,
      (d) => d.discipline
    ).sort((a, b) => b[1] - a[1]);

    const topN = 14;
    const disciplines = byDisc.slice(0, topN).map((d) => d[0]);

    const filtered = athletesExploded.filter((d) => disciplines.includes(d.discipline));

    // Build distributions per (discipline, gender, isMedallist)
    const distMap = new Map();
    for (const r of filtered) {
      const key = `${r.discipline}||${r.gender}||${r.isMedallist ? "M" : "P"}`;
      if (!distMap.has(key)) distMap.set(key, []);
      distMap.get(key).push(r.age);
    }

    // default selected discipline
    const selected = disciplines[0] || "Swimming";
    setupViolin(disciplines, distMap, filtered);
    selectDiscipline(selected, distMap, medals, medallists);

  }).catch((e) => {
    console.error(e);
    alert("Failed to load data files. Check paths in /data.");
  });

  // -----------------------------
  // Split Violin Plot (D3)
  // -----------------------------
  function setupViolin(disciplines, distMap, filteredRows) {
    const svg = d3.select("#violin-svg");
    svg.selectAll("*").remove();

    const wrap = document.getElementById("violin-wrap");
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;

    const margin = { top: 18, right: 50, bottom: 50, left: 160 };
    const width = W;
    const height = H;

    svg.attr("viewBox", `0 0 ${width} ${height}`);

    // Calculate actual age extent from data
    const ages = filteredRows.map((d) => d.age).filter((x) => isFinite(x));
    const minAge = Math.floor(d3.min(ages)) - 1;
    const maxAge = Math.ceil(d3.max(ages)) + 1;

    const x = d3.scaleLinear()
      .domain([Math.max(10, minAge), Math.min(55, maxAge)])
      .range([margin.left, width - margin.right]);

    const y = d3.scaleBand()
      .domain(disciplines)
      .range([margin.top, height - margin.bottom])
      .paddingInner(0.20)
      .paddingOuter(0.10);

    // Count participants and medallists separately for scaling
    const discStats = new Map();
    for (const disc of disciplines) {
      const participants = filteredRows.filter(r => r.discipline === disc && !r.isMedallist).length;
      const medallists = filteredRows.filter(r => r.discipline === disc && r.isMedallist).length;
      discStats.set(disc, { participants, medallists, total: participants + medallists });
    }
    
    const maxParticipants = d3.max(Array.from(discStats.values()), d => d.participants) || 1;
    const maxMedallists = d3.max(Array.from(discStats.values()), d => d.medallists) || 1;

    const baseMaxAmp = Math.min(38, y.bandwidth() * 0.44);

    // KDE settings
    const bandwidth = 1.6;
    const ticks = x.ticks(40);

    function kernelGaussian(k) {
      return (v) => Math.exp(-0.5 * (v / k) * (v / k)) / (k * Math.sqrt(2 * Math.PI));
    }

    function kde(kernel, X) {
      return (V) => X.map((x0) => [x0, d3.mean(V, (v) => kernel(x0 - v)) || 0]);
    }

    const g = svg.append("g");

    // axes
    g.append("g")
      .attr("transform", `translate(0,${height - margin.bottom})`)
      .call(d3.axisBottom(x).ticks(8))
      .call(styleAxis);

    g.append("text")
      .attr("x", (margin.left + width - margin.right) / 2)
      .attr("y", height - 12)
      .attr("text-anchor", "middle")
      .attr("fill", "rgba(255,255,255,0.78)")
      .style("font-size", "12px")
      .text("Age (as of 2025-01-18)");

    // Create tooltip
    let tip = d3.select("body").select(".tooltip");
    if (tip.empty()) tip = d3.select("body").append("div").attr("class", "tooltip");
    
    const showTip = (px, py, title, sub) => {
      tip
        .style("left", (px + 15) + "px")
        .style("top", (py - 10) + "px")
        .html(`<div class="t-title">${title}</div><div class="t-sub">${sub}</div>`)
        .classed("show", true);
    };
    const hideTip = () => tip.classed("show", false);

    // Build y "button-like" labels (rect + text), clickable
    const yButtons = g.append("g").attr("class", "y-buttons");

    const yBtn = yButtons.selectAll(".ybtn")
      .data(disciplines)
      .join("g")
      .attr("class", (d) => `ybtn ${d === disciplines[0] ? "active" : ""}`)
      .attr("transform", (d) => {
        const cy = y(d) + y.bandwidth() / 2;
        return `translate(${margin.left - 10},${cy})`;
      })
      .on("click", (event, d) => {
        setActiveDiscipline(d);
      })
      .on("mouseenter", (event, d) => {
        const stats = discStats.get(d);
        showTip(event.clientX, event.clientY, d, 
          `Participants: ${stats.participants} | Medallists: ${stats.medallists}`);
      })
      .on("mouseleave", hideTip);

    const btnW = margin.left - 28;
    const btnH = Math.min(28, y.bandwidth() * 0.55);

    yBtn.append("rect")
      .attr("class", "ybtn-bg")
      .attr("x", -btnW)
      .attr("y", -btnH / 2)
      .attr("rx", 999)
      .attr("ry", 999)
      .attr("width", btnW)
      .attr("height", btnH);

    yBtn.append("text")
      .attr("x", -btnW + 12)
      .attr("y", 4)
      .attr("text-anchor", "start")
      .text((d) => d);

    // draw violins
    const area = d3.area()
      .x((d) => x(d[0]))
      .y0((d) => d.y0)
      .y1((d) => d.y1)
      .curve(d3.curveCatmullRom.alpha(0.6));

    const discLayer = g.append("g").attr("class", "violins");

    for (const disc of disciplines) {
      const cy = y(disc) + y.bandwidth() / 2;

      const femaleP = distMap.get(`${disc}||female||P`) || [];
      const femaleM = distMap.get(`${disc}||female||M`) || [];
      const maleP = distMap.get(`${disc}||male||P`) || [];
      const maleM = distMap.get(`${disc}||male||M`) || [];

      // Calculate amplitude based on count - participants get full amplitude, medallists get proportional
      const stats = discStats.get(disc);
      const pAmp = baseMaxAmp * Math.sqrt(stats.participants / maxParticipants);
      const mAmp = baseMaxAmp * Math.sqrt(stats.medallists / maxParticipants) * 0.8; // medallists are smaller

      // Draw participants (lighter, background)
      drawHalfViolin(discLayer, disc, cy, -1, femaleP, pAmp, "rgba(232,196,216,0.30)", "Female participants", femaleP.length);
      drawHalfViolin(discLayer, disc, cy, +1, maleP, pAmp, "rgba(127,214,217,0.30)", "Male participants", maleP.length);

      // Draw medallists (darker, foreground - smaller and more distinct)
      drawHalfViolin(discLayer, disc, cy, -1, femaleM, mAmp, "rgba(255,130,180,0.85)", "Female medallists", femaleM.length);
      drawHalfViolin(discLayer, disc, cy, +1, maleM, mAmp, "rgba(80,220,220,0.85)", "Male medallists", maleM.length);

      // quartile lines for medallists only (more visible)
      drawQuartiles(discLayer, disc, cy, -1, femaleM, mAmp, "Female medallists");
      drawQuartiles(discLayer, disc, cy, +1, maleM, mAmp, "Male medallists");
    }

    function drawHalfViolin(layer, disc, cy, side, values, amp, fillColor, labelTitle, count) {
      if (!values || values.length < 5) return;

      const kdeFn = kde(kernelGaussian(bandwidth), ticks);
      const dens = kdeFn(values);

      const maxD = d3.max(dens, (d) => d[1]) || 1e-9;
      const wScale = d3.scaleLinear().domain([0, maxD]).range([0, amp]);

      const sign = side;

      const data = dens.map((d) => {
        const w = wScale(d[1]);
        const y0 = cy + sign * 1;
        const y1 = cy + sign * (1 + w);
        return { 0: d[0], 1: d[1], y0, y1 };
      });

      const path = layer.append("path")
        .datum(data)
        .attr("d", area.x((d) => x(d[0])).y0((d) => d.y0).y1((d) => d.y1))
        .attr("fill", fillColor)
        .attr("stroke", "rgba(255,255,255,0.15)")
        .attr("stroke-width", 0.6)
        .attr("pointer-events", "all")
        .style("cursor", "crosshair");

      // Pre-calculate bins for hover
      const bins = d3.bin().domain(x.domain()).thresholds(ticks)(values);

      path.on("mousemove", function(event) {
        const [mx] = d3.pointer(event, svg.node());
        const age = x.invert(mx);

        // Find current bin
        let currentCount = 0;
        for (const bn of bins) {
          if (age >= bn.x0 && age < bn.x1) { 
            currentCount = bn.length; 
            break; 
          }
        }

        showTip(
          event.clientX,
          event.clientY,
          `${disc} • ${labelTitle}`,
          `Age ${age.toFixed(1)}: ${currentCount} people (Total: ${count})`
        );
      }).on("mouseleave", function() {
        hideTip();
      });
    }

    function drawQuartiles(layer, disc, cy, side, values, amp, label) {
      if (!values || values.length < 5) return;

      const sorted = values.slice().sort((a, b) => a - b);
      const q1 = d3.quantileSorted(sorted, 0.25);
      const q2 = d3.quantileSorted(sorted, 0.50);
      const q3 = d3.quantileSorted(sorted, 0.75);

      const sign = side;
      const yNear = cy + sign * 1;
      const yFar = cy + sign * (1 + Math.min(amp, 20));

      const lines = [
        { x: q1, t: "Q1 (25th percentile)", age: q1.toFixed(1), dasharray: "4,3" },
        { x: q2, t: "Median (50th percentile)", age: q2.toFixed(1), dasharray: "none" },
        { x: q3, t: "Q3 (75th percentile)", age: q3.toFixed(1), dasharray: "4,3" },
      ];

      const grp = layer.append("g");

      grp.selectAll("line")
        .data(lines)
        .join("line")
        .attr("class", "qline")
        .attr("x1", (d) => x(d.x))
        .attr("x2", (d) => x(d.x))
        .attr("y1", yNear)
        .attr("y2", yFar)
        .attr("stroke", "rgba(255,255,255,0.9)")
        .attr("stroke-width", 2)
        .attr("stroke-dasharray", (d) => d.dasharray)
        .attr("pointer-events", "all")
        .style("cursor", "help")
        .on("mousemove", (event, d) => {
          showTip(event.clientX, event.clientY, 
            `${disc} • ${label}`, 
            `${d.t}\nAge = ${d.age} years`);
        })
        .on("mouseleave", hideTip);
    }

    // Add scale legend on the right - height matches actual max violin amplitude
    const legendX = width - margin.right + 10;
    const legendY = margin.top + 20;
    
    const scaleLegend = g.append("g")
      .attr("transform", `translate(${legendX}, ${legendY})`);

    // Scale bar - height = baseMaxAmp (actual max violin height)
    const scaleHeight = baseMaxAmp;
    const scaleWidth = 12;
    
    scaleLegend.append("rect")
      .attr("x", 0)
      .attr("y", 0)
      .attr("width", scaleWidth)
      .attr("height", scaleHeight)
      .attr("fill", "rgba(127,214,217,0.5)")
      .attr("stroke", "rgba(255,255,255,0.4)")
      .attr("rx", 3);

    // Scale labels - top shows max count
    scaleLegend.append("text")
      .attr("x", scaleWidth + 4)
      .attr("y", 8)
      .attr("fill", "rgba(255,255,255,0.7)")
      .style("font-size", "9px")
      .text(`${maxParticipants}`);

    scaleLegend.append("text")
      .attr("x", scaleWidth + 4)
      .attr("y", scaleHeight)
      .attr("fill", "rgba(255,255,255,0.7)")
      .style("font-size", "9px")
      .text("0");

    scaleLegend.append("text")
      .attr("x", scaleWidth / 2)
      .attr("y", scaleHeight + 14)
      .attr("text-anchor", "middle")
      .attr("fill", "rgba(255,255,255,0.6)")
      .style("font-size", "8px")
      .text("Count");

    // expose selection handler
    window.__AGE_SELECT_DISCIPLINE__ = setActiveDiscipline;

    function setActiveDiscipline(disc) {
      yButtons.selectAll(".ybtn").classed("active", (x) => x === disc);
      if (window.__AGE_UPDATE_RIGHT__) window.__AGE_UPDATE_RIGHT__(disc);
      const t = document.getElementById("age-right-title");
      if (t) t.textContent = `Selected sport: ${disc}`;
    }

    function styleAxis(sel) {
      sel.selectAll("path, line").attr("stroke", "rgba(255,255,255,0.18)");
      sel.selectAll("text")
        .attr("fill", "rgba(255,255,255,0.75)")
        .style("font-size", "12px")
        .style("font-family", "'Montserrat', sans-serif");
    }
  }

  // -----------------------------
  // Right panel charts (BoxPlot + Top Nations)
  // -----------------------------
  function selectDiscipline(disc, distMap, medals, medallists) {
    window.__AGE_UPDATE_RIGHT__ = (d) => {
      renderBoxPlot(d, medallists);
      renderTopNations(d, medals);
      const sub = document.getElementById("age-right-sub");
      if (sub) sub.textContent = "Box plot uses medallists — ages computed from athletes birthdates.";
    };

    if (window.__AGE_UPDATE_RIGHT__) window.__AGE_UPDATE_RIGHT__(disc);

    setTimeout(() => {
      if (window.__AGE_SELECT_DISCIPLINE__) window.__AGE_SELECT_DISCIPLINE__(disc);
    }, 50);
  }

  function renderBoxPlot(discipline, medallists) {
    const svg = d3.select("#boxplot-svg");
    svg.selectAll("*").remove();

    const ref = new Date("2025-01-18T00:00:00");

    // Use medallists.csv directly - it has birth_date field
    const rows = medallists
      .filter((m) => String(m.discipline || "").trim() === discipline)
      .map((m) => {
        const birthStr = m.birth_date;
        if (!birthStr) return null;
        const bd = parseDate(birthStr);
        if (!bd) return null;
        const age = (ref - bd) / (365.25 * 24 * 3600 * 1000);
        return {
          event: String(m.event || "Unknown").trim(),
          gender: norm(m.gender),
          age: age
        };
      })
      .filter(Boolean)
      .filter((d) => isFinite(d.age));

    if (rows.length === 0) {
      svg.append("text")
        .attr("x", 14).attr("y", 28)
        .attr("fill", "rgba(255,255,255,0.7)")
        .style("font-size", "12px")
        .text("No medalist age data found for this sport.");
      return;
    }

    // pick top events
    const byEvent = d3.rollups(rows, (v) => v.length, (d) => d.event)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 7)
      .map((d) => d[0]);

    const data = rows.filter((r) => byEvent.includes(r.event));
    if (data.length === 0) {
      svg.append("text")
        .attr("x", 14).attr("y", 28)
        .attr("fill", "rgba(255,255,255,0.7)")
        .style("font-size", "12px")
        .text("No medalist age data found for this sport.");
      return;
    }

    const container = svg.node().parentElement;
    const wrapW = container.clientWidth || 400;
    const wrapH = Math.max(200, byEvent.length * 45 + 60);
    
    svg.attr("width", wrapW)
       .attr("height", wrapH)
       .attr("viewBox", `0 0 ${wrapW} ${wrapH}`);

      const margin = { top: 20, right: 30, bottom: 40, left: 140 };

      const ages = data.map((d) => d.age);
      const minAge = Math.floor(d3.min(ages)) - 1;
      const maxAge = Math.ceil(d3.max(ages)) + 1;
      
      const x = d3.scaleLinear()
        .domain([Math.max(15, minAge), Math.min(50, maxAge)])
        .range([margin.left, wrapW - margin.right]);

      const y = d3.scaleBand()
        .domain(byEvent)
        .range([margin.top, wrapH - margin.bottom])
        .paddingInner(0.35);

      const g = svg.append("g");

      // axis
      g.append("g")
        .attr("transform", `translate(0,${wrapH - margin.bottom})`)
        .call(d3.axisBottom(x).ticks(6))
        .call(styleAxisSmall);

      // y labels
      g.append("g")
        .attr("transform", `translate(${margin.left},0)`)
        .call(d3.axisLeft(y).tickSize(0))
        .call((sel) => {
          sel.selectAll("text")
            .attr("fill", "rgba(255,255,255,0.78)")
            .style("font-size", "10px")
            .style("font-family", "'Montserrat', sans-serif")
            .each(function() {
              const text = d3.select(this);
              const label = text.text();
              if (label.length > 20) {
                text.text(label.substring(0, 18) + "...");
              }
            });
          sel.select(".domain").remove();
        });

      const grouped = d3.group(data, (d) => d.event);

      const tip = ensureTooltip();

      for (const ev of byEvent) {
        const y0 = y(ev);
        if (y0 == null) continue;

        const evData = (grouped.get(ev) || []).map((d) => d.age).sort((a, b) => a - b);
        drawBox(ev, evData, y0 + y.bandwidth() / 2, "rgba(180,160,220,0.7)");
      }

      function drawBox(ev, arr, yCenter, fill) {
        if (!arr || arr.length < 3) return;

        const q1 = d3.quantileSorted(arr, 0.25);
        const q2 = d3.quantileSorted(arr, 0.50);
        const q3 = d3.quantileSorted(arr, 0.75);
        const iqr = q3 - q1;
        const lo = Math.max(d3.min(arr), q1 - 1.5 * iqr);
        const hi = Math.min(d3.max(arr), q3 + 1.5 * iqr);

        const boxH = Math.max(12, y.bandwidth() * 0.6);

        // whisker
        g.append("line")
          .attr("x1", x(lo)).attr("x2", x(hi))
          .attr("y1", yCenter).attr("y2", yCenter)
          .attr("stroke", "rgba(255,255,255,0.5)")
          .attr("stroke-width", 1.5);

        // box
        g.append("rect")
          .attr("x", x(q1))
          .attr("y", yCenter - boxH / 2)
          .attr("width", Math.max(2, x(q3) - x(q1)))
          .attr("height", boxH)
          .attr("rx", 6).attr("ry", 6)
          .attr("fill", fill)
          .attr("stroke", "rgba(255,255,255,0.3)")
          .attr("stroke-width", 1)
          .on("mousemove", (event) => {
            tip.show(event.clientX, event.clientY,
              ev,
              `Q1=${q1.toFixed(1)} | Median=${q2.toFixed(1)} | Q3=${q3.toFixed(1)} | n=${arr.length}`
            );
          })
          .on("mouseleave", tip.hide);

        // median line
        g.append("line")
          .attr("x1", x(q2)).attr("x2", x(q2))
          .attr("y1", yCenter - boxH / 2)
          .attr("y2", yCenter + boxH / 2)
          .attr("stroke", "rgba(255,255,255,0.95)")
          .attr("stroke-width", 2);
      }

      function styleAxisSmall(sel) {
        sel.selectAll("path, line").attr("stroke", "rgba(255,255,255,0.18)");
        sel.selectAll("text")
          .attr("fill", "rgba(255,255,255,0.75)")
          .style("font-size", "11px")
          .style("font-family", "'Montserrat', sans-serif");
      }
  }

  function renderTopNations(discipline, medals) {
    const svg = d3.select("#topnations-svg");
    svg.selectAll("*").remove();

    const rows = medals.filter((m) => String(m.discipline || "").trim() === discipline);
    if (rows.length === 0) {
      svg.append("text")
        .attr("x", 14).attr("y", 28)
        .attr("fill", "rgba(255,255,255,0.7)")
        .style("font-size", "12px")
        .text("No medal records found for this sport.");
      return;
    }

    const byCountry = d3.rollups(
      rows,
      (v) => v.length,
      (d) => String(d.country || d.country_long || "Unknown").trim()
    ).sort((a, b) => b[1] - a[1]).slice(0, 8);

    const data = byCountry.map(([country, count]) => ({ country, count }));

    const container = svg.node().parentElement;
    const wrapW = container.clientWidth || 400;
    const wrapH = Math.max(180, data.length * 32 + 60);

    svg.attr("width", wrapW)
       .attr("height", wrapH)
       .attr("viewBox", `0 0 ${wrapW} ${wrapH}`);

    const margin = { top: 18, right: 40, bottom: 30, left: 100 };

    const x = d3.scaleLinear()
      .domain([0, d3.max(data, (d) => d.count) || 1])
      .nice()
      .range([margin.left, wrapW - margin.right]);

    const y = d3.scaleBand()
      .domain(data.map((d) => d.country))
      .range([margin.top, wrapH - margin.bottom])
      .padding(0.25);

    const g = svg.append("g");

    // axis
    g.append("g")
      .attr("transform", `translate(0,${wrapH - margin.bottom})`)
      .call(d3.axisBottom(x).ticks(5))
      .call(styleAxisSmall);

    g.append("g")
      .attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).tickSize(0))
      .call((sel) => {
        sel.selectAll("text")
          .attr("fill", "rgba(255,255,255,0.78)")
          .style("font-size", "11px")
          .style("font-family", "'Montserrat', sans-serif");
        sel.select(".domain").remove();
      });

    const tip = ensureTooltip();

    g.selectAll("rect.bar")
      .data(data)
      .join("rect")
      .attr("class", "bar")
      .attr("x", x(0))
      .attr("y", (d) => y(d.country))
      .attr("height", y.bandwidth())
      .attr("width", (d) => Math.max(2, x(d.count) - x(0)))
      .attr("rx", 8).attr("ry", 8)
      .attr("fill", "rgba(220,208,255,0.50)")
      .attr("stroke", "rgba(255,255,255,0.18)")
      .attr("stroke-width", 0.8)
      .on("mousemove", (event, d) => {
        tip.show(event.clientX, event.clientY, d.country, `Medals in ${discipline}: ${d.count}`);
      })
      .on("mouseleave", tip.hide);

    g.selectAll("text.value")
      .data(data)
      .join("text")
      .attr("class", "value")
      .attr("x", (d) => x(d.count) + 5)
      .attr("y", (d) => y(d.country) + y.bandwidth() / 2 + 4)
      .attr("fill", "rgba(255,255,255,0.85)")
      .style("font-size", "11px")
      .style("font-weight", "600")
      .style("font-family", "'Montserrat', sans-serif")
      .text((d) => d.count);

    function styleAxisSmall(sel) {
      sel.selectAll("path, line").attr("stroke", "rgba(255,255,255,0.18)");
      sel.selectAll("text")
        .attr("fill", "rgba(255,255,255,0.75)")
        .style("font-size", "10px")
        .style("font-family", "'Montserrat', sans-serif");
    }
  }

  // -----------------------------
  // Tooltip helper (shared)
  // -----------------------------
  function ensureTooltip() {
    let tip = d3.select("body").select(".tooltip");
    if (tip.empty()) tip = d3.select("body").append("div").attr("class", "tooltip");
    return {
      show: (x, y, title, sub) => {
        tip.style("left", x + "px").style("top", y + "px")
          .html(`<div class="t-title">${title}</div><div class="t-sub">${sub}</div>`)
          .classed("show", true);
      },
      hide: () => tip.classed("show", false)
    };
  }

  // -----------------------------
  // Athletes cache for birth_date lookup
  // -----------------------------
  let __ATH_CACHE__ = null;

  function ensureAthCache() {
    if (__ATH_CACHE__) return Promise.resolve(__ATH_CACHE__);
    return d3.csv("../data/athletes.csv").then((ath) => {
      const map = new Map();
      for (const a of ath) {
        const code = String(a.code || "").trim();
        if (!code) continue;
        map.set(code, a);
      }
      __ATH_CACHE__ = map;
      return map;
    });
  }
})();
