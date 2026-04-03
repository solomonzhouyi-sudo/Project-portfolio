/**
 * Paris 2024 - Schedule Heatmap
 * Theme: "Elegant Lavender" (Grey-Purple -> Light Purple)
 * No Neon, No Fluorescence.
 */

(function() {
    // 加载CSV数据
    Promise.all([
        d3.csv('../data/schedules.csv'),
        d3.csv('../data/events.csv')
    ]).then(([schedules, events]) => {
        const goldEvents = schedules.filter(d => d.event_medal === '1');
        
        const grouped = d3.group(goldEvents, 
            d => d.day,
            d => d.discipline
        );
        
        const dates = Array.from(new Set(goldEvents.map(d => d.day))).sort();
        const sports = Array.from(new Set(goldEvents.map(d => d.discipline))).sort();
        
        const heatmapData = [];
        dates.forEach(date => {
            sports.forEach(sport => {
                const count = grouped.get(date)?.get(sport)?.length || 0;
                heatmapData.push({ date, sport, count });
            });
        });
        
        renderHeatmap(heatmapData, dates, sports);
        
        // 统计信息
        document.getElementById('total-events').textContent = goldEvents.length;
        document.getElementById('total-golds').textContent = goldEvents.length;
        document.getElementById('total-sports').textContent = sports.length;
        document.getElementById('total-days').textContent = dates.length;
        
        // Gold Days
        const dailyGolds = Array.from(grouped, ([date, sportMap]) => {
            const count = Array.from(sportMap.values()).reduce((sum, events) => sum + events.length, 0);
            return { date, count, sportsCount: sportMap.size };
        }).sort((a, b) => b.count - a.count);

        const goldDaysList = document.getElementById('gold-days-list');
        dailyGolds.slice(0, 5).forEach(day => {
            const card = document.createElement('div');
            card.className = 'gold-day-card';
            const dateObj = new Date(day.date);
            card.innerHTML = `
                <div class="gold-day-info">
                    <div class="gold-day-date">${dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                    <div style="font-size:0.7rem; color:rgba(255,255,255,0.5)">${day.sportsCount} Sports</div>
                </div>
                <div class="gold-day-count">+${day.count} 🥇</div>
            `;
            goldDaysList.appendChild(card);
        });
        
    });
    
    function renderHeatmap(data, dates, sports) {
        const margin = { top: 20, right: 25, bottom: 80, left: 115 };
        const cellSize = 32;
        const cellPadding = 4;
        
        const width = dates.length * cellSize;
        const height = sports.length * cellSize;
        
        const svg = d3.select('#heatmap-svg')
            .attr('viewBox', `0 0 ${width + margin.left + margin.right} ${height + margin.top + margin.bottom}`)
            .append('g')
            .attr('transform', `translate(${margin.left},${margin.top})`);
        
        const maxCount = d3.max(data, d => d.count);
        
        /* ================== 【配色方案：灰紫 -> 亮浅紫】 ==================
         * 严格遵循要求：无霓虹，浅色系为主。
         */
        const colorScale = d3.scaleLinear()
            .domain([0, 1, maxCount * 0.6, maxCount])
            .range([
                'rgba(255,255,255,0.02)',   // 0: 几乎透明
                'rgba(73, 57, 128, 1)',     // Low: 你指定的深灰紫 (优雅暗部)
                '#9F7AEA',                  // Mid: 柔和的丁香紫 (Medium Purple)
                '#E9D8FD'                   // High: 极浅、极亮的薰衣草紫 (Light Lavender)
            ])
            .interpolate(d3.interpolateRgb); // 使用RGB插值，保证颜色纯净不偏色
            
        // 更新图例背景：灰紫 -> 亮紫
        const legendGradient = document.querySelector('.legend-gradient');
        if(legendGradient) {
            legendGradient.style.background = 'linear-gradient(to right, rgba(73, 57, 128, 1), #9F7AEA, #E9D8FD)';
        }

        const tooltip = d3.select('#schedule-tooltip');
        
        svg.selectAll('rect')
            .data(data)
            .join('rect')
            .attr('class', d => `heatmap-cell ${d.count > 0 ? 'has-data' : ''}`)
            .attr('x', d => dates.indexOf(d.date) * cellSize)
            .attr('y', d => sports.indexOf(d.sport) * cellSize)
            .attr('width', cellSize - cellPadding)
            .attr('height', cellSize - cellPadding)
            .attr('rx', 4)
            .attr('fill', d => colorScale(d.count))
            // 边框：0值微弱边框，有值无边框
            .attr('stroke', d => d.count === 0 ? 'rgba(255,255,255,0.04)' : 'none')
            .attr('stroke-width', 1)
            
            .on('mouseover', function(event, d) {
                if (d.count === 0) return;
                
                d3.select(this).raise();
                
                const dateObj = new Date(d.date);
                tooltip
                    .style('left', event.clientX + 'px')
                    .style('top', event.clientY + 'px')
                    .html(`
                        <div class="tooltip-date">${dateObj.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</div>
                        <div class="tooltip-count" style="color:#E9D8FD">
                            ${d.count} ${d.count === 1 ? 'Gold' : 'Golds'}
                        </div>
                        <div class="tooltip-sports">${d.sport}</div>
                    `)
                    .classed('show', true);
            })
            .on('mousemove', function(event) {
                tooltip
                    .style('left', (event.clientX + 10) + 'px')
                    .style('top', (event.clientY + 10) + 'px');
            })
            .on('mouseout', function() {
                tooltip.classed('show', false);
            });
        
        // X轴
        const xAxis = svg.append('g').attr('transform', `translate(0, ${height + 12})`);
        dates.forEach((date, i) => {
            const dateObj = new Date(date);
            xAxis.append('text')
                .attr('x', i * cellSize + cellSize / 2).attr('y', 0).attr('text-anchor', 'middle').attr('dy', '1em')
                .style('font-size', '0.65rem').style('fill', 'rgba(255,255,255,0.5)').style('font-family', "'Montserrat', sans-serif")
                .text(dateObj.getDate());
            if (i === 0 || dates[i - 1].split('-')[1] !== date.split('-')[1]) {
                xAxis.append('text')
                    .attr('x', i * cellSize + cellSize / 2).attr('y', 22).attr('text-anchor', 'middle')
                    // 月份文字也改为柔和的浅紫
                    .style('font-size', '0.7rem').style('fill', '#D6BCFA').style('font-weight', '700').style('font-family', "'Montserrat', sans-serif")
                    .text(dateObj.toLocaleDateString('en-US', { month: 'short' }));
            }
        });
        
        // Y轴
        const yAxis = svg.append('g').attr('transform', 'translate(-12, 0)');
        sports.forEach((sport, i) => {
            yAxis.append('text')
                .attr('x', 0).attr('y', i * cellSize + cellSize / 2).attr('text-anchor', 'end').attr('dy', '0.35em')
                .style('font-size', '0.7rem').style('fill', 'rgba(255,255,255,0.6)').style('font-family', "'Montserrat', sans-serif").style('font-weight', '400')
                .text(sport);
        });
    }
    
    // 滚动逻辑
    let hasScrolled = false;
    const scrollHint = document.getElementById('scroll-hint');
    window.addEventListener('scroll', () => {
        if (!hasScrolled && window.scrollY > 100) {
            hasScrolled = true;
            scrollHint.classList.add('hide');
        }
        if (window.scrollY < 50) {
            hasScrolled = false;
            scrollHint.classList.remove('hide');
        }
    });
    document.getElementById('back-to-index').addEventListener('click', () => {
        window.location.href = '../index.html';
    });
})();