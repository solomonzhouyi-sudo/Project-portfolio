/**
 * Paris 2024 - Olympic Torch Relay Scroll Logic
 */

const relayData = [
    { city: "Olympia", date: "APR 16, 2024", coords: [21.63, 37.64], desc: "Lighting the flame in the sacred grove of Ancient Olympia." },
    { city: "Athens", date: "APR 26, 2024", coords: [23.73, 37.98], desc: "Handover ceremony at the Panathenaic Stadium." },
    { city: "Marseille", date: "MAY 08, 2024", coords: [5.38, 43.30], desc: "Arrival in France on the historic Belem ship." },
    { city: "Cayenne", date: "JUN 09, 2024", coords: [-52.33, 4.93], desc: "French Guiana: The relay traverses the Amazon rainforest." },
    { city: "Baie-Mahault", date: "JUN 15, 2024", coords: [-61.59, 16.26], desc: "Guadeloupe: Caribbean rhythms in the West Indies." },
    { city: "Fort-de-France", date: "JUN 17, 2024", coords: [-61.06, 14.60], desc: "Martinique: The final Caribbean stopover." },
    { city: "Pape'ete", date: "JUN 13, 2024", coords: [-149.56, -17.53], desc: "Tahiti: Visiting the world-famous surfing shores." },
    { city: "Nouméa", date: "JUN 11, 2024", coords: [166.44, -22.27], desc: "New Caledonia: A jewel in the South Pacific." },
    { city: "Saint-Denis", date: "JUN 12, 2024", coords: [55.45, -20.88], desc: "Réunion Island: Scaling volcanic peaks in the Indian Ocean." },
    { city: "Nice", date: "JUN 18, 2024", coords: [7.26, 43.71], desc: "Returning to the Mediterranean shores of Nice." },
    { city: "Paris", date: "JUL 26, 2024", coords: [2.35, 48.86], desc: "The grand finale in the City of Light." }
];

// --- 状态控制变量 ---
let scrollTimeout = null;
let hasReachedBottom = false;
const scrollHint = document.getElementById('scroll-hint');

// 1. 【要求1修复】：用户打开界面，立马显示滚动提示
if (scrollHint) {
    // 延迟一小会儿确保浏览器渲染完成
    requestAnimationFrame(() => scrollHint.classList.add('show'));
}

// --- 初始化地图与章节（保持原逻辑） ---
const wrapper = d3.select("#scroll-wrapper");

// 城市图标映射
const cityIcons = {
    "Paris": { src: "assets/eiffel-tower.png", class: "paris-icon" }
};

relayData.forEach((d, i) => {
    const isFinal = i === relayData.length - 1;
    const hasIcon = cityIcons[d.city];
    
    let cardContent;
    
    if (hasIcon) {
        // 有图标的卡片 - 图标在卡片内部右侧
        cardContent = `
            <div class="station-card has-icon">
                <div class="card-content">
                    <div class="station-number">STAGE ${String(i+1).padStart(2, '0')}</div>
                    <div class="station-title">${d.city}</div>
                    <div class="station-date">📅 ${d.date}</div>
                    <div class="station-description">${d.desc}</div>
                </div>
                <img src="${hasIcon.src}" alt="${d.city}" class="city-icon ${hasIcon.class}" />
            </div>
        `;
    } else {
        // 普通卡片
        cardContent = `
            <div class="station-card">
                <div class="station-number">STAGE ${String(i+1).padStart(2, '0')}</div>
                <div class="station-title">${d.city}</div>
                <div class="station-date">📅 ${d.date}</div>
                <div class="station-description">${d.desc}</div>
            </div>
        `;
    }
    
    wrapper.append("div")
        .attr("class", `scroll-section ${isFinal ? 'final-stage' : ''}`)
        .html(cardContent);
});

const svg = d3.select("#map-svg");
const projection = d3.geoNaturalEarth1().scale(window.innerWidth / 5.2).translate([window.innerWidth / 2.1, window.innerHeight / 1.9]);
const pathGen = d3.geoPath().projection(projection);
const bgCenterScale = d3.scaleLinear().domain([0, 0.5, 1]).range(["#030308", "#1A2B6D", "#BFA2E3"]);
const bgEdgeScale = d3.scaleLinear().domain([0, 0.5, 1]).range(["#020205", "#0A1442", "#9D82C3"]);

d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json").then(world => {
    const countries = topojson.feature(world, world.objects.countries);
    svg.append("g").selectAll(".country").data(countries.features).join("path").attr("class", "country").attr("d", pathGen);

    const lineGen = d3.line().x(d => projection(d.coords)[0]).y(d => projection(d.coords)[1]).curve(d3.curveCatmullRom.alpha(0.5));
    const activeP = svg.append("path").datum(relayData).attr("class", "route-active").attr("d", lineGen);
    const totalL = activeP.node().getTotalLength();
    activeP.style("stroke-dasharray", totalL).style("stroke-dashoffset", totalL);

    const torch = svg.append("g").style("filter", "url(#torch-glow)");
    torch.append("circle").attr("r", 6).attr("fill", "#FF1A1A");
    torch.append("circle").attr("r", 15).attr("fill", "rgba(255, 26, 26, 0.3)");

    const pointPos = relayData.map((_, i) => {
        if (i === 0) return 0;
        const temp = svg.append("path").datum(relayData.slice(0, i + 1)).attr("d", lineGen).attr("visibility", "hidden");
        const l = temp.node().getTotalLength(); temp.remove(); return l;
    });

    function render(progress) {
        document.body.style.background = `radial-gradient(circle at center, ${bgCenterScale(progress)} 0%, ${bgEdgeScale(progress)} 100%)`;
        const i = Math.max(0, Math.min(progress * (relayData.length-1), (relayData.length-1)-0.0001));
        const idx = Math.floor(i), t = i - idx;
        const curL = pointPos[idx] + (pointPos[idx+1] - pointPos[idx]) * t;
        activeP.style("stroke-dashoffset", totalL - curL);
        const p = activeP.node().getPointAtLength(curL);
        torch.attr("transform", `translate(${p.x}, ${p.y})`);

        // 【要求1修复】：滑动到底部时，彻底禁用滚动提示
        if (progress > 0.98) {
            hasReachedBottom = true; 
            if (scrollHint) scrollHint.classList.remove('show');
            d3.select("#start-btn").classed("visible", true);
        } else {
            hasReachedBottom = false;
            d3.select("#start-btn").classed("visible", false);
        }
    }

    // --- 滚动核心逻辑 ---
    window.addEventListener('scroll', () => {
        const scrollProp = window.scrollY / (document.documentElement.scrollHeight - window.innerHeight);
        window.requestAnimationFrame(() => render(Math.max(0, Math.min(1, scrollProp))));

        // 【要求1修复】：用户开始滚动后提示消失
        if (scrollHint) scrollHint.classList.remove('show');
        
        // 清除现有的定时器
        clearTimeout(scrollTimeout);

        // 【要求1修复】：如果没有到达底部，静止一秒后再次显示提示
        if (!hasReachedBottom) {
            scrollTimeout = setTimeout(() => {
                // 再次检查此时是否由于之前的操作已到达底部
                if (!hasReachedBottom && scrollHint) {
                    scrollHint.classList.add('show');
                }
            }, 1000);
        }
    });

    const obs = new IntersectionObserver((es) => es.forEach(e => { 
        if(e.isIntersecting) {
            e.target.querySelector('.station-card').classList.add('visible');
        }
    }), { threshold: 0.5 });
    document.querySelectorAll('.scroll-section').forEach(s => obs.observe(s));
    render(0);
});

// --- Iris 动画逻辑（保持原逻辑） ---
const btn = d3.select("#start-btn");
const irisSvg = btn.insert("svg", ":first-child").attr("id", "iris-svg").attr("viewBox", "0 0 320 180");
const irisData = [[[160, 180], [160, 130], [150, 80], [160, 40]],[[160, 180], [165, 140], [170, 90], [160, 50]],[[160, 180], [140, 150], [110, 120], [90, 140]],[[160, 180], [130, 160], [100, 140], [80, 160]],[[160, 180], [180, 150], [210, 120], [230, 140]],[[160, 180], [190, 160], [220, 140], [240, 160]],[[160, 180], [155, 120], [160, 100]],[[160, 180], [165, 120], [160, 100]]];
const irisLineGen = d3.line().x(d => d[0]).y(d => d[1]).curve(d3.curveBasis);
const irisPaths = irisSvg.selectAll(".iris-path").data(irisData).join("path").attr("class", "iris-path").attr("d", irisLineGen).attr("stroke", "url(#iris-grad)").style("filter", "url(#iris-bloom-glow)");
irisPaths.each(function() { const len = this.getTotalLength(); d3.select(this).attr("stroke-dasharray", len).attr("stroke-dashoffset", len); });
btn.on("mouseenter", () => { irisPaths.transition().duration((d, i) => 800 + i * 100).ease(d3.easeCubicOut).attr("stroke-dashoffset", 0); }).on("mouseleave", () => { irisPaths.transition().duration(600).ease(d3.easeCubicIn).attr("stroke-dashoffset", function() { return this.getTotalLength(); }); });

document.getElementById("start-btn").addEventListener("click", () => {
    // 1. 【核心修改】：立即清除行内样式，让紫色背景瞬间消失，恢复初始黑色
    document.body.style.background = "#030308"; 
    
    // 2. 立即添加退出类，触发地图和文字的缩放、模糊效果
    document.body.classList.add("page-exit");
    
    // 3. 400ms 后跳转（略微缩短时间，让用户感觉反应更快）
    window.setTimeout(() => {
        window.location.href = "pages/schedule_medals.html";
    }, 200);
});
