// =============================================
// SCALABLE CONFIGURATION
// Change ONLY these 4 values to adjust resolution
// =============================================
window.CONFIG = {
    // Display size (CSS pixels - what you see on screen)
    displayWidth: 450,
    displayHeight: 400,
    
    // Drawing size (actual canvas pixels - for sharpness)
    drawWidth: 900,     // 2x display size
    drawHeight: 800,    // 2x display size
    
    // Base dimensions (for 450x400 display)
    base: {
        margin: { top: 20, right: 20, bottom: 50, left: 95 },
        fontSize: 11,
        fontSizeBold: 12,
        fontSizeLegend: 12,
        fontSizeParams: 11,
        lineWidth: 1,
        lineWidthAxis: 1,
        dotRadius: 4,
        boxSize: 14,
        padding: 12,
        textPadding: 10,
        ySpacing: 10,
        tickLength: 5,
        axisLabelOffset: 5,
        yLabelOffset: 80,
        legendXOffset: 25,
        legendYOffset: 10,
        boxOffset: 4,
        textOffset: 4,
        textVerticalOffset: 2,
        legendItemXOffset: -5,
        resetButton: {
            top: 10,
            right: 10,
            paddingX: 6,
            paddingY: 3,
            borderRadius: 3,
            fontSize: 10
        }
    },
    
    // Legend and Parameter Box Configuration
    LEGEND_CONFIG: {
        box: {
            padding: 6,
            borderRadius: 4,
            strokeStyle: '#666666',
            lineWidth: 1,
            fillStyle: 'rgba(0, 0, 0, 0.3)'
        },
        text: {
            decimalPlaces: 2
        }
    },
    
    PARAMS_CONFIG: {
        box: {
            padding: 6,
            borderRadius: 4,
            strokeStyle: '#666666',
            lineWidth: 1,
            fillStyle: 'rgba(0, 0, 0, 0.3)',
            ySpacing: 10
        }
    },
    
    // Calculate scale factor automatically
    get scale() {
        return this.drawWidth / this.displayWidth;
    },
    
    // Scaled dimensions (use these everywhere)
    get margin() {
        return {
            top: this.base.margin.top * this.scale,
            right: this.base.margin.right * this.scale,
            bottom: this.base.margin.bottom * this.scale,
            left: this.base.margin.left * this.scale
        };
    },
    get fontSize() { return this.base.fontSize * this.scale; },
    get fontSizeBold() { return this.base.fontSizeBold * this.scale; },
    get fontSizeLegend() { return this.base.fontSizeLegend * this.scale; },
    get fontSizeParams() { return this.base.fontSizeParams * this.scale; },
    get lineWidth() { return this.base.lineWidth * this.scale; },
    get lineWidthAxis() { return this.base.lineWidthAxis * this.scale; },
    get dotRadius() { return this.base.dotRadius * this.scale; },
    get boxSize() { return this.base.boxSize * this.scale; },
    get padding() { return this.base.padding * this.scale; },
    get textPadding() { return this.base.textPadding * this.scale; },
    get ySpacing() { return this.base.ySpacing * this.scale; },
    get tickLength() { return this.base.tickLength * this.scale; },
    get axisLabelOffset() { return this.base.axisLabelOffset * this.scale; },
    get yLabelOffset() { return this.base.yLabelOffset * this.scale; },
    get legendXOffset() { return this.base.legendXOffset * this.scale; },
    get legendYOffset() { return this.base.legendYOffset * this.scale; },
    get boxOffset() { return this.base.boxOffset * this.scale; },
    get textOffset() { return this.base.textOffset * this.scale; },
    get textVerticalOffset() { return this.base.textVerticalOffset * this.scale; },
    get legendItemXOffset() { return this.base.legendItemXOffset * this.scale; },
    get resetButton() {
        return {
            top: this.base.resetButton.top * this.scale,
            right: this.base.resetButton.right * this.scale,
            paddingX: this.base.resetButton.paddingX * this.scale,
            paddingY: this.base.resetButton.paddingY * this.scale,
            borderRadius: this.base.resetButton.borderRadius * this.scale,
            fontSize: this.base.resetButton.fontSize * this.scale
        };
    }
};

// =============================================
// PLOT STATE MANAGEMENT
// =============================================
window.plotStates = {
    'ev-plot': {
        original: null,
        current: { xMin: null, xMax: null, yMin: null, yMax: null }
    },
    'pv-plot': {
        original: null,
        current: { xMin: null, xMax: null, yMin: null, yMax: null }
    }
};

// =============================================
// Reset plot state function
// =============================================
window.resetPlotState = function(canvasId) {
    if (window.plotStates[canvasId]) {
        window.plotStates[canvasId].original = null;
        window.plotStates[canvasId].current = {
            xMin: null, xMax: null, yMin: null, yMax: null
        };
    }
};

// =============================================
// UTILITY FUNCTIONS
// =============================================
window.niceNum = function(range, round) {
    const exponent = Math.floor(Math.log10(range));
    const fraction = range / Math.pow(10, exponent);
    let niceFraction;
    if (round) {
        if (fraction < 1.5) niceFraction = 1;
        else if (fraction < 3) niceFraction = 2;
        else if (fraction < 7) niceFraction = 5;
        else niceFraction = 10;
    } else {
        if (fraction <= 1) niceFraction = 1;
        else if (fraction <= 2) niceFraction = 2;
        else if (fraction <= 5) niceFraction = 5;
        else niceFraction = 10;
    }
    return niceFraction * Math.pow(10, exponent);
};

// FIXED: Skip scientific notation for volume until > 10000
window.formatTick = function(value, isVolume = false) {
    const abs = Math.abs(value);
    if (isVolume) {
        if (abs >= 10000) return value.toExponential(2);
        else return value.toFixed(2);
    }
    if (abs >= 1000 || (abs > 0 && abs < 0.01)) {
        return value.toExponential(2);
    } else if (abs < 1) {
        return value.toFixed(4);
    } else if (abs < 10) {
        return value.toFixed(3);
    } else {
        return value.toFixed(2);
    }
};

// FIXED: Calculate axis limits with proper padding for negative values
window.getAxisLimits = function(data, paddingPercent = 0.05) {
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min;
    const padding = range * paddingPercent;
    return { min: min - padding, max: max + padding };
};

// =============================================
// DRAWING FUNCTIONS
// =============================================
window.drawPlotAxes = function(ctx, xMin, xMax, yMin, yMax, xLabel, yLabel, width, height, isVolumeX = false) {
    const { top, right, bottom, left } = CONFIG.margin;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;

    ctx.fillStyle = '#121212';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = '#444444';
    ctx.lineWidth = CONFIG.lineWidthAxis;
    ctx.strokeRect(left, top, plotWidth, plotHeight);

    ctx.strokeStyle = '#666666';
    ctx.lineWidth = CONFIG.lineWidth;

    ctx.beginPath();
    ctx.moveTo(left, top + plotHeight);
    ctx.lineTo(left + plotWidth, top + plotHeight);
    ctx.moveTo(left, top);
    ctx.lineTo(left, top + plotHeight);
    ctx.stroke();

    ctx.fillStyle = '#e0e0e0';
    ctx.font = `${CONFIG.fontSize}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const xRange = xMax - xMin;
    const xSpacing = window.niceNum(xRange / 5, true);
    const xStart = Math.ceil(xMin / xSpacing) * xSpacing;

    for (let xVal = xStart; xVal <= xMax; xVal += xSpacing) {
        const xPos = left + ((xVal - xMin) / xRange) * plotWidth;
        ctx.beginPath();
        ctx.moveTo(xPos, top + plotHeight);
        ctx.lineTo(xPos, top + plotHeight + CONFIG.tickLength);
        ctx.stroke();
        ctx.fillText(window.formatTick(xVal, true), xPos, top + plotHeight + CONFIG.tickLength + CONFIG.axisLabelOffset);
    }

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const yRange = yMax - yMin;
    const ySpacing = window.niceNum(yRange / 5, true);
    const yStart = Math.ceil(yMin / ySpacing) * ySpacing;

    for (let yVal = yStart; yVal <= yMax; yVal += ySpacing) {
        const yPos = top + plotHeight - ((yVal - yMin) / yRange) * plotHeight;
        ctx.beginPath();
        ctx.moveTo(left, yPos);
        ctx.lineTo(left - CONFIG.tickLength, yPos);
        ctx.stroke();
        ctx.fillText(window.formatTick(yVal), left - CONFIG.tickLength - CONFIG.axisLabelOffset, yPos);
    }

    ctx.font = `bold ${CONFIG.fontSizeBold}px Arial`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(xLabel, width / 2, height - CONFIG.axisLabelOffset);

    ctx.save();
    ctx.translate(left - CONFIG.yLabelOffset, height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();
};

window.plotPoints = function(ctx, x, y, color, width, height, plotXMin, plotXMax, plotYMin, plotYMax) {
    const { top, right, bottom, left } = CONFIG.margin;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, plotWidth, plotHeight);
    ctx.clip();

    ctx.fillStyle = color;
    for (let i = 0; i < x.length; i++) {
        if (x[i] >= plotXMin && x[i] <= plotXMax && y[i] >= plotYMin && y[i] <= plotYMax) {
            const px = left + ((x[i] - plotXMin) / (plotXMax - plotXMin)) * plotWidth;
            const py = top + plotHeight - ((y[i] - plotYMin) / (plotYMax - plotYMin)) * plotHeight;
            ctx.beginPath();
            ctx.arc(px, py, CONFIG.dotRadius, 0, 2 * Math.PI);
            ctx.fill();
        }
    }
    ctx.restore();
};

window.plotFunction = function(ctx, xMin, xMax, func, width, height, plotYMin, plotYMax, color, lineWidth) {
    const { top, right, bottom, left } = CONFIG.margin;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const nPoints = 500;

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, plotWidth, plotHeight);
    ctx.clip();

    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth * CONFIG.lineWidth;
    ctx.beginPath();

    for (let i = 0; i <= nPoints; i++) {
        const x = xMin + (i / nPoints) * (xMax - xMin);
        const y = func(x);

        if (x >= xMin && x <= xMax && y >= plotYMin && y <= plotYMax) {
            const px = left + ((x - xMin) / (xMax - xMin)) * plotWidth;
            const py = top + plotHeight - ((y - plotYMin) / (plotYMax - plotYMin)) * plotHeight;

            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
    }
    ctx.stroke();
    ctx.restore();
};

// Helper function to draw rounded rectangle
window.drawRoundedRect = function(ctx, x, y, width, height, radius, fillStyle, strokeStyle, lineWidth) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    
    if (fillStyle) {
        ctx.fillStyle = fillStyle;
        ctx.fill();
    }
    
    if (strokeStyle) {
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = lineWidth * CONFIG.lineWidth;
        ctx.stroke();
    }
};

// Draws legend with color swatches and parameters with boxes
window.addLegendAndParams = function(ctx, labels, colors, params, width, height, position) {
    const { top, right, bottom, left } = CONFIG.margin;
    
    // Legend box position from right
    const boxX = position === 'top-right' ? width - right - CONFIG.legendXOffset : left + CONFIG.legendXOffset;
    let currentY = top + CONFIG.legendYOffset;

    ctx.font = `${CONFIG.fontSizeLegend}px Arial`;

    // ===== LEGEND =====
    // Measure legend text widths
    let maxLabelWidth = 0;
    for (let i = 0; i < labels.length; i++) {
        const textWidth = ctx.measureText(labels[i]).width;
        if (textWidth > maxLabelWidth) maxLabelWidth = textWidth;
    }
    
    // Legend box dimensions
    const legendBoxWidth = CONFIG.boxSize + CONFIG.padding + CONFIG.textPadding + maxLabelWidth;
    const legendBoxHeight = labels.length * (CONFIG.fontSizeLegend * 1.6) + CONFIG.padding * 1.5;

    // Draw legend box
    ctx.save();
    window.drawRoundedRect(
        ctx,
        boxX - legendBoxWidth,
        currentY - CONFIG.boxOffset,
        legendBoxWidth,
        legendBoxHeight,
        CONFIG.LEGEND_CONFIG.box.borderRadius,
        CONFIG.LEGEND_CONFIG.box.fillStyle,
        CONFIG.LEGEND_CONFIG.box.strokeStyle,
        CONFIG.LEGEND_CONFIG.box.lineWidth
    );
    ctx.restore();

    // Draw legend items (color swatches + labels)
    for (let i = 0; i < labels.length; i++) {
        const yPos = currentY + i * (CONFIG.fontSizeLegend * 1.6) + CONFIG.padding * 0.5 + CONFIG.textVerticalOffset;
        const itemX = boxX - legendBoxWidth + CONFIG.padding + CONFIG.legendItemXOffset;
        
        ctx.fillStyle = colors[i];
        ctx.fillRect(itemX, yPos - CONFIG.boxSize/2, CONFIG.boxSize, CONFIG.boxSize);
        
        ctx.fillStyle = '#e0e0e0';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(labels[i], itemX + CONFIG.boxSize + CONFIG.textPadding, yPos);
    }

    // ===== PARAMETERS =====
    if (params) {
        // Add spacing between legend and parameters
        currentY += legendBoxHeight + CONFIG.ySpacing;
        
        const decimalPlaces = CONFIG.LEGEND_CONFIG.text.decimalPlaces;
        const paramLines = [
            `V₀ = ${params.v0.toFixed(decimalPlaces)} Å³`,
            `K₀ = ${params.k0.toFixed(decimalPlaces)} GPa`,
            `K₀′ = ${params.k0prime.toFixed(decimalPlaces)}`
        ];

        if (params.e0 !== undefined) {
            paramLines.unshift(`E₀ = ${params.e0.toFixed(decimalPlaces)} eV`);
        }

        // Measure parameter text widths
        ctx.font = `${CONFIG.fontSizeParams}px Arial`;
        let maxParamWidth = 0;
        for (let i = 0; i < paramLines.length; i++) {
            const textWidth = ctx.measureText(paramLines[i]).width;
            if (textWidth > maxParamWidth) maxParamWidth = textWidth;
        }
        
        // Parameter box dimensions
        const paramsBoxWidth = Math.max(legendBoxWidth, maxParamWidth + CONFIG.padding * 2);
        const paramsBoxHeight = paramLines.length * (CONFIG.fontSizeParams * 1.6) + CONFIG.padding * 1.5;

        // Draw parameter box
        ctx.save();
        window.drawRoundedRect(
            ctx,
            boxX - paramsBoxWidth,
            currentY - CONFIG.boxOffset,
            paramsBoxWidth,
            paramsBoxHeight,
            CONFIG.PARAMS_CONFIG.box.borderRadius,
            CONFIG.PARAMS_CONFIG.box.fillStyle,
            CONFIG.PARAMS_CONFIG.box.strokeStyle,
            CONFIG.PARAMS_CONFIG.box.lineWidth
        );
        ctx.restore();

        // Draw parameter text
        ctx.fillStyle = '#e0e0e0';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        for (let i = 0; i < paramLines.length; i++) {
            const yPos = currentY + i * (CONFIG.fontSizeParams * 1.6) + CONFIG.padding * 0.5 + CONFIG.textVerticalOffset;
            ctx.fillText(paramLines[i], boxX - paramsBoxWidth + CONFIG.padding + CONFIG.legendItemXOffset, yPos);
        }
    }
};

// =============================================
// MAIN PLOTTING FUNCTIONS
// =============================================
window.plotEV = function(volumes, energies, fitFunc, fitParams, minEnergy, canvasId) {
    canvasId = canvasId || 'ev-plot';
    const canvas = document.getElementById(canvasId);
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const state = window.plotStates[canvasId];

    let vMin, vMax, eMin, eMax;
    if (state.current.xMin !== null) {
        vMin = state.current.xMin;
        vMax = state.current.xMax;
        eMin = state.current.yMin;
        eMax = state.current.yMax;
    } else {
        const vLimits = window.getAxisLimits(volumes, 0.05);
        const eLimits = window.getAxisLimits(energies, 0.05);
        vMin = vLimits.min;
        vMax = vLimits.max;
        eMin = eLimits.min;
        eMax = eLimits.max;

        state.original = { xMin: vMin, xMax: vMax, yMin: eMin, yMax: eMax };
        state.current = { xMin: vMin, xMax: vMax, yMin: eMin, yMax: eMax };
    }

    ctx.clearRect(0, 0, width, height);

    const funcEValues = Array.from({length: 201}, (_, i) => {
        const V = vMin + (i/200) * (vMax - vMin);
        return fitFunc(V, ...fitParams);
    });
    const funcEMin = Math.min(...funcEValues);
    const funcEMax = Math.max(...funcEValues);

    const combinedEMin = Math.min(eMin, funcEMin);
    const combinedEMax = Math.max(eMax, funcEMax);

    window.drawPlotAxes(ctx, vMin, vMax, combinedEMin, combinedEMax, 'Volume (Å³)', 'Energy (eV)', width, height, true);
    window.plotPoints(ctx, volumes, energies, window.COLORS.DATA, width, height, vMin, vMax, combinedEMin, combinedEMax);
    window.plotFunction(ctx, vMin, vMax, (V) => fitFunc(V, ...fitParams),
                width, height, combinedEMin, combinedEMax, window.COLORS.EV_FIT, 2);

    const evParams = {
        e0: fitParams[0],
        v0: fitParams[1],
        k0: fitParams[2],
        k0prime: fitParams[3]
    };
    window.addLegendAndParams(ctx, ['Data', 'Fit'],
                              [window.COLORS.DATA, window.COLORS.EV_FIT],
                              evParams, width, height, 'top-right');
};

window.plotPV = function(volumes, pressures, pvFitParams, evFitParams, canvasId) {
    canvasId = canvasId || 'pv-plot';
    const canvas = document.getElementById(canvasId);
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    const state = window.plotStates[canvasId];

    let vMin, vMax, pMin, pMax;
    if (state.current.xMin !== null) {
        vMin = state.current.xMin;
        vMax = state.current.xMax;
        pMin = state.current.yMin;
        pMax = state.current.yMax;
    } else {
        const pvV0 = pvFitParams[0];
        const evV0 = evFitParams[1];
        const allVolumes = [...volumes, pvV0, evV0];

        const vLimits = window.getAxisLimits(allVolumes, 0.05);
        const pLimits = window.getAxisLimits([...pressures, 0], 0.05);
        vMin = vLimits.min;
        vMax = vLimits.max;
        pMin = pLimits.min;
        pMax = pLimits.max;

        state.original = { xMin: vMin, xMax: vMax, yMin: pMin, yMax: pMax };
        state.current = { xMin: vMin, xMax: vMax, yMin: pMin, yMax: pMax };
    }

    ctx.clearRect(0, 0, width, height);

    const pvFuncValues = Array.from({length: 201}, (_, i) => {
        const V = vMin + (i/200) * (vMax - vMin);
        return window.birchMurnaghanPressure(V, pvFitParams[0], pvFitParams[1], pvFitParams[2]);
    });
    const evFuncValues = Array.from({length: 201}, (_, i) => {
        const V = vMin + (i/200) * (vMax - vMin);
        return window.birchMurnaghanPressure(V, evFitParams[1], evFitParams[2], evFitParams[3]);
    });

    const combinedPMin = Math.min(pMin, Math.min(...pvFuncValues), Math.min(...evFuncValues));
    const combinedPMax = Math.max(pMax, Math.max(...pvFuncValues), Math.max(...evFuncValues));

    window.drawPlotAxes(ctx, vMin, vMax, combinedPMin, combinedPMax, 'Volume (Å³)', 'Pressure (GPa)', width, height, true);

    const { top, right, bottom, left } = CONFIG.margin;
    const plotHeight = height - top - bottom;
    const zeroY = top + plotHeight - ((0 - combinedPMin) / (combinedPMax - combinedPMin)) * plotHeight;
    ctx.strokeStyle = '#666666';
    ctx.setLineDash([CONFIG.tickLength * 2, CONFIG.tickLength * 2]);
    ctx.beginPath();
    ctx.moveTo(left, zeroY);
    ctx.lineTo(width - right, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);

    window.plotPoints(ctx, volumes, pressures, window.COLORS.DATA, width, height, vMin, vMax, combinedPMin, combinedPMax);
    
    // P-V Fit line (solid)
    window.plotFunction(ctx, vMin, vMax, (V) => window.birchMurnaghanPressure(V, pvFitParams[0], pvFitParams[1], pvFitParams[2]),
                width, height, combinedPMin, combinedPMax, window.COLORS.PV_FIT, 2);
    
    // FIXED: P from E-V line (dashed)
    ctx.save();
    ctx.setLineDash([10, 10]); // 10px solid, 10px gap
    window.plotFunction(ctx, vMin, vMax, (V) => window.birchMurnaghanPressure(V, evFitParams[1], evFitParams[2], evFitParams[3]),
                width, height, combinedPMin, combinedPMax, window.COLORS.EV_FIT, 2);
    ctx.restore();

    const pvParams = {
        v0: pvFitParams[0],
        k0: pvFitParams[1],
        k0prime: pvFitParams[2]
    };
    window.addLegendAndParams(ctx, ['Data', 'P-V Fit', 'P from E-V'],
                              [window.COLORS.DATA, window.COLORS.PV_FIT, window.COLORS.EV_FIT],
                              pvParams, width, height, 'top-right');
};

// =============================================
// CANVAS INTERACTIONS
// =============================================
window.setupCanvasInteractions = function(canvasId) {
    const canvas = document.getElementById(canvasId);
    const state = window.plotStates[canvasId];

    let selectionRect = document.getElementById(`${canvasId}-selection`);
    if (!selectionRect) {
        selectionRect = document.createElement('div');
        selectionRect.id = `${canvasId}-selection`;
        selectionRect.style.position = 'absolute';
        selectionRect.style.border = `${CONFIG.lineWidth}px dashed #666`;
        selectionRect.style.background = 'rgba(100, 100, 255, 0.2)';
        selectionRect.style.display = 'none';
        selectionRect.style.pointerEvents = 'none';
        selectionRect.style.zIndex = '1000';
        canvas.parentNode.style.position = 'relative';
        canvas.parentNode.appendChild(selectionRect);
    }

    let resetButton = document.getElementById(`${canvasId}-reset`);
    if (!resetButton) {
        resetButton = document.createElement('button');
        resetButton.id = `${canvasId}-reset`;
        resetButton.textContent = 'Reset';
        resetButton.style.position = 'absolute';
        resetButton.style.top = `${CONFIG.resetButton.top}px`;
        resetButton.style.right = `${CONFIG.resetButton.right}px`;
        resetButton.style.zIndex = '10';
        resetButton.style.background = '#444';
        resetButton.style.color = '#fff';
        resetButton.style.border = 'none';
        resetButton.style.borderRadius = `${CONFIG.resetButton.borderRadius}px`;
        resetButton.style.padding = `${CONFIG.resetButton.paddingY}px ${CONFIG.resetButton.paddingX}px`;
        resetButton.style.cursor = 'pointer';
        resetButton.style.fontSize = `${CONFIG.resetButton.fontSize}px`;
        resetButton.onclick = () => window.resetZoom(canvasId);
        canvas.parentNode.appendChild(resetButton);
    }

    let isPanning = false;
    let isBoxSelecting = false;
    let startClient = { x: 0, y: 0 };
    let startRanges = null;
    let parentRect = null;

    function updateParentRect() {
        parentRect = canvas.parentNode.getBoundingClientRect();
    }

    function getCanvasRect() {
        return canvas.getBoundingClientRect();
    }

    function clientToCanvas(clientX, clientY) {
        const rect = getCanvasRect();
        return {
            x: (clientX - rect.left) * (canvas.width / rect.width),
            y: (clientY - rect.top) * (canvas.height / rect.height)
        };
    }

    function canvasToData(canvasX, canvasY) {
        const { top, left } = CONFIG.margin;
        const plotWidth = canvas.width - left - CONFIG.margin.right;
        const plotHeight = canvas.height - top - CONFIG.margin.bottom;
        const dataX = state.current.xMin + ((canvasX - left) / plotWidth) * (state.current.xMax - state.current.xMin);
        const dataY = state.current.yMax - ((canvasY - top) / plotHeight) * (state.current.yMax - state.current.yMin);
        return { x: dataX, y: dataY };
    }

    function redraw() {
        window.redrawPlot(canvasId);
    }

    canvas.addEventListener('mousedown', function(e) {
        updateParentRect();
        startClient = { x: e.clientX, y: e.clientY };
        startRanges = {
            xMin: state.current.xMin,
            xMax: state.current.xMax,
            yMin: state.current.yMin,
            yMax: state.current.yMax
        };

        if (e.shiftKey) {
            isBoxSelecting = true;
            selectionRect.style.display = 'block';
            selectionRect.style.left = `${e.clientX - parentRect.left}px`;
            selectionRect.style.top = `${e.clientY - parentRect.top}px`;
            selectionRect.style.width = '0px';
            selectionRect.style.height = '0px';
            canvas.style.cursor = 'crosshair';
        } else {
            isPanning = true;
            canvas.style.cursor = 'grabbing';
        }
        e.preventDefault();
    });

    canvas.addEventListener('mousemove', function(e) {
        updateParentRect();
        if (isPanning) {
            const canvasPos = clientToCanvas(e.clientX, e.clientY);
            const startCanvasPos = clientToCanvas(startClient.x, startClient.y);

            const { top, left } = CONFIG.margin;
            const plotWidth = canvas.width - left - CONFIG.margin.right;
            const plotHeight = canvas.height - top - CONFIG.margin.bottom;

            const dx = (startCanvasPos.x - canvasPos.x) / plotWidth * (startRanges.xMax - startRanges.xMin);
            const dy = (startCanvasPos.y - canvasPos.y) / plotHeight * (startRanges.yMax - startRanges.yMin);

            state.current.xMin = startRanges.xMin + dx;
            state.current.xMax = startRanges.xMax + dx;
            state.current.yMin = startRanges.yMin + dy;
            state.current.yMax = startRanges.yMax + dy;
            redraw();
        } else if (isBoxSelecting) {
            const x = e.clientX - parentRect.left;
            const y = e.clientY - parentRect.top;
            const startX = startClient.x - parentRect.left;
            const startY = startClient.y - parentRect.top;

            selectionRect.style.left = `${Math.min(startX, x)}px`;
            selectionRect.style.top = `${Math.min(startY, y)}px`;
            selectionRect.style.width = `${Math.abs(x - startX)}px`;
            selectionRect.style.height = `${Math.abs(y - startY)}px`;
        }
    });

    canvas.addEventListener('mouseup', function(e) {
        updateParentRect();
        if (isBoxSelecting) {
            const endClient = { x: e.clientX, y: e.clientY };
            const startCanvas = clientToCanvas(startClient.x, startClient.y);
            const endCanvas = clientToCanvas(endClient.x, endClient.y);
            const startData = canvasToData(startCanvas.x, startCanvas.y);
            const endData = canvasToData(endCanvas.x, endCanvas.y);

            const xMin = Math.min(startData.x, endData.x);
            const xMax = Math.max(startData.x, endData.x);
            const yMin = Math.min(startData.y, endData.y);
            const yMax = Math.max(startData.y, endData.y);

            const xRange = xMax - xMin;
            const yRange = yMax - yMin;
            const paddingX = 0.05 * xRange;
            const paddingY = 0.05 * yRange;

            state.current.xMin = xMin - paddingX;
            state.current.xMax = xMax + paddingX;
            state.current.yMin = yMin - paddingY;
            state.current.yMax = yMax + paddingY;

            selectionRect.style.display = 'none';
            redraw();
        }
        isPanning = false;
        isBoxSelecting = false;
        canvas.style.cursor = 'default';
    });

    canvas.addEventListener('mouseleave', function() {
        isPanning = false;
        isBoxSelecting = false;
        canvas.style.cursor = 'default';
    });

    canvas.addEventListener('dblclick', function() {
        window.resetZoom(canvasId);
    });
};

// =============================================
// RESET ZOOM
// =============================================
window.resetZoom = function(canvasId) {
    if (window.plotStates[canvasId] && window.plotStates[canvasId].original) {
        window.plotStates[canvasId].current = {
            xMin: window.plotStates[canvasId].original.xMin,
            xMax: window.plotStates[canvasId].original.xMax,
            yMin: window.plotStates[canvasId].original.yMin,
            yMax: window.plotStates[canvasId].original.yMax
        };
        window.redrawPlot(canvasId);
    }
};

// =============================================
// REDRAW PLOT
// =============================================
window.redrawPlot = function(canvasId) {
    if (canvasId === 'ev-plot' && window.globalData) {
        window.plotEV(
            window.globalData.volumes_A3,
            window.globalData.energies_eV,
            window.birchMurnaghanEnergy,
            window.globalData.evResult.params,
            window.globalData.minEnergy,
            canvasId
        );
    } else if (canvasId === 'pv-plot' && window.globalData) {
        window.plotPV(
            window.globalData.volumes_A3,
            window.globalData.pressures_GPa,
            window.globalData.pvResult.params,
            window.globalData.evResult.params,
            canvasId
        );
    }
};

// =============================================
// INITIALIZE
// =============================================
document.addEventListener('DOMContentLoaded', function() {
    window.setupCanvasInteractions('ev-plot');
    window.setupCanvasInteractions('pv-plot');
});
