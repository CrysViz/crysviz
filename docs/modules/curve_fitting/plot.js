// =============================================
// BASE CONFIGURATION
// =============================================
window.BASE_CONFIG = {
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
        yLabelOffset: 60,
        legendXOffset: 25,
        legendYOffset: 10,
        boxOffset: 4,
        textOffset: 4,
        textVerticalOffset: 2,
        legendItemXOffset: -5
    },
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
    originalDisplay: { width: 450, height: 400 }
};

// =============================================
// GET SCALED CONFIG FOR A SPECIFIC CANVAS
// =============================================
window.getCanvasScale = function(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return 1;
    const displayWidth = parseFloat(canvas.style.width);
    const drawWidth = canvas.width;
    return drawWidth / displayWidth;
};

window.getCanvasConfig = function(canvasId) {
    const canvas = document.getElementById(canvasId);
    const displayWidth = parseFloat(canvas.style.width) || window.BASE_CONFIG.originalDisplay.width;
    const displayHeight = parseFloat(canvas.style.height) || window.BASE_CONFIG.originalDisplay.height;
    const scale = window.getCanvasScale(canvasId);
    
    // Calculate size ratio relative to original 450x400
    const originalWidth = window.BASE_CONFIG.originalDisplay.width;
    const originalHeight = window.BASE_CONFIG.originalDisplay.height;
    const widthRatio = displayWidth / originalWidth;
    const heightRatio = displayHeight / originalHeight;
    const sizeRatio = Math.min(widthRatio, heightRatio);
    
    const base = window.BASE_CONFIG.base;
    const LEGEND_CONFIG = window.BASE_CONFIG.LEGEND_CONFIG;
    const PARAMS_CONFIG = window.BASE_CONFIG.PARAMS_CONFIG;
    
    return {
        scale: scale,
        sizeRatio: sizeRatio,
        displayWidth: displayWidth,
        displayHeight: displayHeight,
        margin: {
            top: base.margin.top * scale * sizeRatio,
            right: base.margin.right * scale * sizeRatio,
            bottom: base.margin.bottom * scale * sizeRatio,
            left: base.margin.left * scale * sizeRatio
        },
        fontSize: base.fontSize * scale * sizeRatio,
        fontSizeBold: base.fontSizeBold * scale * sizeRatio,
        fontSizeLegend: base.fontSizeLegend * scale * sizeRatio,
        fontSizeParams: base.fontSizeParams * scale * sizeRatio,
        lineWidth: base.lineWidth * scale * sizeRatio,
        lineWidthAxis: base.lineWidthAxis * scale * sizeRatio,
        dotRadius: base.dotRadius * scale * sizeRatio,
        boxSize: base.boxSize * scale * sizeRatio,
        padding: base.padding * scale * sizeRatio,
        textPadding: base.textPadding * scale * sizeRatio,
        ySpacing: base.ySpacing * scale * sizeRatio,
        tickLength: base.tickLength * scale * sizeRatio,
        axisLabelOffset: base.axisLabelOffset * scale * sizeRatio,
        yLabelOffset: base.yLabelOffset * scale * sizeRatio,
        legendXOffset: base.legendXOffset * scale * sizeRatio,
        legendYOffset: base.legendYOffset * scale * sizeRatio,
        boxOffset: base.boxOffset * scale * sizeRatio,
        textOffset: base.textOffset * scale * sizeRatio,
        textVerticalOffset: base.textVerticalOffset * scale * sizeRatio,
        legendItemXOffset: base.legendItemXOffset * scale * sizeRatio,
        LEGEND_CONFIG: LEGEND_CONFIG,
        PARAMS_CONFIG: PARAMS_CONFIG
    };
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
// Global resize state
// =============================================
window.resizeState = {
    isResizing: false,
    activeCanvasId: null,
    startX: 0,
    startY: 0,
    startWidth: 0,
    startHeight: 0
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

window.getAxisLimits = function(data, paddingPercent = 0.05) {
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min;
    const padding = range * paddingPercent;
    return { min: min - padding, max: max + padding };
};

// Get theme colors for a specific plot
window.getPlotThemeColors = function(canvasId) {
    const wrapper = document.getElementById(`${canvasId}-wrapper`);
    const isLight = wrapper && wrapper.classList.contains('light-mode');
    
    return {
        bgPrimary: isLight ? '#ffffff' : '#121212',
        bgSecondary: isLight ? '#f5f5f5' : '#1e1e1e',
        bgTertiary: isLight ? '#e0e0e0' : '#2d2d2d',
        textPrimary: isLight ? '#121212' : '#e0e0e0',
        textSecondary: isLight ? '#444444' : '#aaaaaa',
        textTertiary: isLight ? '#000000' : '#ffffff',
        borderColor: isLight ? '#cccccc' : '#444',
        plotBg: isLight ? '#ffffff' : '#121212',
        canvasBorder: isLight ? '#cccccc' : '#444',
        axisColor: isLight ? '#666666' : '#666666',
        gridColor: isLight ? '#cccccc' : '#444444',
        legendFill: isLight ? 'rgba(255, 255, 255, 0.7)' : 'rgba(0, 0, 0, 0.3)',
        legendStroke: isLight ? '#666666' : '#666666',
        selectionBg: isLight ? 'rgba(0, 0, 0, 0.2)' : 'rgba(255, 255, 255, 0.2)',
        selectionBorder: isLight ? '#000000' : '#ffffff'
    };
};

// =============================================
// EXPORT FUNCTION - 4x resolution PNG
// =============================================
window.exportPlotAsPNG = function(canvasId) {
    const canvas = document.getElementById(canvasId);
    
    // Get DISPLAY dimensions
    const displayWidth = parseFloat(canvas.style.width);
    const displayHeight = parseFloat(canvas.style.height);
    
    // Save original canvas dimensions and state
    const originalWidth = canvas.width;
    const originalHeight = canvas.height;
    const originalState = window.plotStates[canvasId] ? { ...window.plotStates[canvasId].current } : null;
    
    // Set canvas to 4x DISPLAY size for export
    const exportScale = 4;
    canvas.width = displayWidth * exportScale;
    canvas.height = displayHeight * exportScale;
    
    // Use full view for export
    if (window.plotStates[canvasId] && window.plotStates[canvasId].original) {
        window.plotStates[canvasId].current = {
            xMin: window.plotStates[canvasId].original.xMin,
            xMax: window.plotStates[canvasId].original.xMax,
            yMin: window.plotStates[canvasId].original.yMin,
            yMax: window.plotStates[canvasId].original.yMax
        };
    }
    
    // Redraw at 4x resolution
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
    
    // Create temp canvas and copy the high-res image
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(canvas, 0, 0);
    
    // Restore original canvas dimensions and state
    canvas.width = originalWidth;
    canvas.height = originalHeight;
    if (originalState && window.plotStates[canvasId]) {
        window.plotStates[canvasId].current = originalState;
    }
    
    // Redraw to restore the plot
    window.redrawPlot(canvasId);
    
    // Download
    const link = document.createElement('a');
    link.download = `${canvasId}.png`;
    link.href = tempCanvas.toDataURL('image/png');
    link.click();
};

// =============================================
// DRAWING FUNCTIONS
// =============================================
window.drawPlotAxes = function(ctx, xMin, xMax, yMin, yMax, xLabel, yLabel, width, height, isVolumeX = false) {
    const canvasId = ctx.canvas.id || (ctx.canvas && ctx.canvas.id) || 'ev-plot';
    const cfg = window.getCanvasConfig(canvasId);
    const colors = window.getPlotThemeColors(canvasId);
    const { top, right, bottom, left } = cfg.margin;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;

    ctx.fillStyle = colors.plotBg;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = colors.gridColor;
    ctx.lineWidth = cfg.lineWidthAxis;
    ctx.strokeRect(left, top, plotWidth, plotHeight);

    ctx.strokeStyle = colors.axisColor;
    ctx.lineWidth = cfg.lineWidth;

    ctx.beginPath();
    ctx.moveTo(left, top + plotHeight);
    ctx.lineTo(left + plotWidth, top + plotHeight);
    ctx.moveTo(left, top);
    ctx.lineTo(left, top + plotHeight);
    ctx.stroke();

    ctx.fillStyle = colors.textPrimary;
    ctx.font = `${cfg.fontSize}px Arial`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const xRange = xMax - xMin;
    const xSpacing = window.niceNum(xRange / 5, true);
    const xStart = Math.ceil(xMin / xSpacing) * xSpacing;

    for (let xVal = xStart; xVal <= xMax; xVal += xSpacing) {
        const xPos = left + ((xVal - xMin) / xRange) * plotWidth;
        ctx.beginPath();
        ctx.moveTo(xPos, top + plotHeight);
        ctx.lineTo(xPos, top + plotHeight + cfg.tickLength);
        ctx.stroke();
        ctx.fillText(window.formatTick(xVal, true), xPos, top + plotHeight + cfg.tickLength + cfg.axisLabelOffset);
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
        ctx.lineTo(left - cfg.tickLength, yPos);
        ctx.stroke();
        ctx.fillText(window.formatTick(yVal), left - cfg.tickLength - cfg.axisLabelOffset, yPos);
    }

    ctx.font = `bold ${cfg.fontSizeBold}px Arial`;
    ctx.fillStyle = colors.textTertiary;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(xLabel, width / 2, height - cfg.axisLabelOffset);

    ctx.save();
    ctx.translate(left - cfg.yLabelOffset, height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(yLabel, 0, 0);
    ctx.restore();
};

window.plotPoints = function(ctx, x, y, color, width, height, plotXMin, plotXMax, plotYMin, plotYMax) {
    const canvasId = ctx.canvas.id || (ctx.canvas && ctx.canvas.id) || 'ev-plot';
    const cfg = window.getCanvasConfig(canvasId);
    const { top, right, bottom, left } = cfg.margin;
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
            ctx.arc(px, py, cfg.dotRadius, 0, 2 * Math.PI);
            ctx.fill();
        }
    }
    ctx.restore();
};

window.plotFunction = function(ctx, xMin, xMax, func, width, height, plotYMin, plotYMax, color, lineWidth) {
    const canvasId = ctx.canvas.id || (ctx.canvas && ctx.canvas.id) || 'ev-plot';
    const cfg = window.getCanvasConfig(canvasId);
    const { top, right, bottom, left } = cfg.margin;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const nPoints = 500;

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, plotWidth, plotHeight);
    ctx.clip();

    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth * cfg.lineWidth;
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
    const canvasId = ctx.canvas.id || (ctx.canvas && ctx.canvas.id) || 'ev-plot';
    const cfg = window.getCanvasConfig(canvasId);
    const scaledLineWidth = lineWidth * cfg.lineWidth;
    
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
        ctx.lineWidth = scaledLineWidth;
        ctx.stroke();
    }
};

// Draws legend with color swatches and parameters with boxes
window.addLegendAndParams = function(ctx, labels, colors, params, width, height, position) {
    const canvasId = ctx.canvas.id || (ctx.canvas && ctx.canvas.id) || 'ev-plot';
    const cfg = window.getCanvasConfig(canvasId);
    const colorsTheme = window.getPlotThemeColors(canvasId);
    const { top, right, bottom, left } = cfg.margin;
    
    // Legend box position from right
    const boxX = position === 'top-right' ? width - right - cfg.legendXOffset : left + cfg.legendXOffset;
    let currentY = top + cfg.legendYOffset;

    ctx.font = `${cfg.fontSizeLegend}px Arial`;

    // Measure legend text widths
    let maxLabelWidth = 0;
    for (let i = 0; i < labels.length; i++) {
        const textWidth = ctx.measureText(labels[i]).width;
        if (textWidth > maxLabelWidth) maxLabelWidth = textWidth;
    }
    
    // Legend box dimensions
    const legendBoxWidth = cfg.boxSize + cfg.padding + cfg.textPadding + maxLabelWidth;
    const legendBoxHeight = labels.length * (cfg.fontSizeLegend * 1.6) + cfg.padding * 1.5;

    // Draw legend box
    ctx.save();
    window.drawRoundedRect(
        ctx,
        boxX - legendBoxWidth,
        currentY - cfg.boxOffset,
        legendBoxWidth,
        legendBoxHeight,
        cfg.LEGEND_CONFIG.box.borderRadius,
        colorsTheme.legendFill,
        colorsTheme.legendStroke,
        cfg.LEGEND_CONFIG.box.lineWidth
    );
    ctx.restore();

    // Draw legend items (color swatches + labels)
    for (let i = 0; i < labels.length; i++) {
        const yPos = currentY + i * (cfg.fontSizeLegend * 1.6) + cfg.padding * 0.5 + cfg.textVerticalOffset;
        const itemX = boxX - legendBoxWidth + cfg.padding + cfg.legendItemXOffset;
        
        ctx.fillStyle = colors[i];
        ctx.fillRect(itemX, yPos - cfg.boxSize/2, cfg.boxSize, cfg.boxSize);
        
        ctx.fillStyle = colorsTheme.textPrimary;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(labels[i], itemX + cfg.boxSize + cfg.textPadding, yPos);
    }

    // Parameter box
    if (params) {
        currentY += legendBoxHeight + cfg.ySpacing;
        
        const decimalPlaces = cfg.LEGEND_CONFIG.text.decimalPlaces;
        const paramLines = [
            `V₀ = ${params.v0.toFixed(decimalPlaces)} Å³`,
            `K₀ = ${params.k0.toFixed(decimalPlaces)} GPa`,
            `K₀′ = ${params.k0prime.toFixed(decimalPlaces)}`
        ];

        if (params.e0 !== undefined) {
            paramLines.unshift(`E₀ = ${params.e0.toFixed(decimalPlaces)} eV`);
        }

        // Measure parameter text widths
        ctx.font = `${cfg.fontSizeParams}px Arial`;
        let maxParamWidth = 0;
        for (let i = 0; i < paramLines.length; i++) {
            const textWidth = ctx.measureText(paramLines[i]).width;
            if (textWidth > maxParamWidth) maxParamWidth = textWidth;
        }
        
        // Parameter box dimensions
        const paramsBoxWidth = Math.max(legendBoxWidth, maxParamWidth + cfg.padding * 2);
        const paramsBoxHeight = paramLines.length * (cfg.fontSizeParams * 1.6) + cfg.padding * 1.5;

        // Draw parameter box
        ctx.save();
        window.drawRoundedRect(
            ctx,
            boxX - paramsBoxWidth,
            currentY - cfg.boxOffset,
            paramsBoxWidth,
            paramsBoxHeight,
            cfg.PARAMS_CONFIG.box.borderRadius,
            colorsTheme.legendFill,
            colorsTheme.legendStroke,
            cfg.PARAMS_CONFIG.box.lineWidth
        );
        ctx.restore();

        // Draw parameter text
        ctx.fillStyle = colorsTheme.textPrimary;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        for (let i = 0; i < paramLines.length; i++) {
            const yPos = currentY + i * (cfg.fontSizeParams * 1.6) + cfg.padding * 0.5 + cfg.textVerticalOffset;
            ctx.fillText(paramLines[i], boxX - paramsBoxWidth + cfg.padding + cfg.legendItemXOffset, yPos);
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

    const colorsTheme = window.getPlotThemeColors(canvasId);
    window.drawPlotAxes(ctx, vMin, vMax, combinedPMin, combinedPMax, 'Volume (Å³)', 'Pressure (GPa)', width, height, true);

    const cfg = window.getCanvasConfig(canvasId);
    const { top, right, bottom, left } = cfg.margin;
    const plotHeight = height - top - bottom;
    const zeroY = top + plotHeight - ((0 - combinedPMin) / (combinedPMax - combinedPMin)) * plotHeight;
    ctx.strokeStyle = colorsTheme.axisColor;
    ctx.setLineDash([cfg.tickLength * 2, cfg.tickLength * 2]);
    ctx.beginPath();
    ctx.moveTo(left, zeroY);
    ctx.lineTo(width - right, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);

    window.plotPoints(ctx, volumes, pressures, window.COLORS.DATA, width, height, vMin, vMax, combinedPMin, combinedPMax);
    
    window.plotFunction(ctx, vMin, vMax, (V) => window.birchMurnaghanPressure(V, pvFitParams[0], pvFitParams[1], pvFitParams[2]),
                width, height, combinedPMin, combinedPMax, window.COLORS.PV_FIT, 2);
    
    ctx.save();
    ctx.setLineDash([10, 5]);
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
// GLOBAL RESIZE HANDLERS
// =============================================
window.setupGlobalResizeHandlers = function() {
    // Single set of event listeners for all resize operations
    document.addEventListener('mousemove', function(e) {
        if (!window.resizeState.isResizing || !window.resizeState.activeCanvasId) return;
        
        const canvas = document.getElementById(window.resizeState.activeCanvasId);
        const wrapper = document.getElementById(`${window.resizeState.activeCanvasId}-wrapper`);
        if (!canvas || !wrapper) return;
        
        const newWidth = window.resizeState.startWidth + (e.clientX - window.resizeState.startX);
        const newHeight = window.resizeState.startHeight + (e.clientY - window.resizeState.startY);
        
        // Minimum size
        if (newWidth < 300 || newHeight < 200) return;
        
        // Update canvas and wrapper size
        canvas.style.width = `${newWidth}px`;
        canvas.style.height = `${newHeight}px`;
        wrapper.style.width = `${newWidth}px`;
        
        // Update drawing buffer (3x for sharpness in expanded mode)
        const isExpanded = wrapper.classList.contains('expanded');
        const multiplier = isExpanded ? 3 : 2;
        canvas.width = newWidth * multiplier;
        canvas.height = newHeight * multiplier;
        
        // Redraw
        window.redrawPlot(window.resizeState.activeCanvasId);
    });

    document.addEventListener('mouseup', function() {
        if (window.resizeState.isResizing) {
            window.resizeState.isResizing = false;
            window.resizeState.activeCanvasId = null;
            document.body.style.cursor = '';
        }
    });

    window.startResize = function(canvasId, e) {
        window.resizeState.isResizing = true;
        window.resizeState.activeCanvasId = canvasId;
        window.resizeState.startX = e.clientX;
        window.resizeState.startY = e.clientY;
        window.resizeState.startWidth = parseFloat(document.getElementById(canvasId).style.width);
        window.resizeState.startHeight = parseFloat(document.getElementById(canvasId).style.height);
        document.body.style.cursor = 'nwse-resize';
        e.preventDefault();
        e.stopPropagation();
    };
};

// =============================================
// CANVAS INTERACTIONS
// =============================================
window.setupCanvasInteractions = function(canvasId) {
    const canvas = document.getElementById(canvasId);
    const state = window.plotStates[canvasId];
    const wrapper = document.getElementById(`${canvasId}-wrapper`);

    if (!canvas || !wrapper) return;

    // Create selection rectangle
    let selectionRect = document.getElementById(`${canvasId}-selection`);
    if (!selectionRect) {
        selectionRect = document.createElement('div');
        selectionRect.id = `${canvasId}-selection`;
        selectionRect.style.position = 'absolute';
        selectionRect.style.border = '1px dashed';
        selectionRect.style.background = 'rgba(255, 255, 255, 0.2)';
        selectionRect.style.display = 'none';
        selectionRect.style.pointerEvents = 'none';
        selectionRect.style.zIndex = '1000';
        wrapper.style.position = 'relative';
        wrapper.appendChild(selectionRect);
    }

    // Button positions (right: close/expand, export, theme, reset)
    const buttonPositions = {
        reset: { right: '130px', top: '10px' },
        theme: { right: '90px', top: '10px' },
        export: { right: '50px', top: '10px' },
        expand: { right: '10px', top: '10px' },
        close: { right: '10px', top: '10px' }
    };

    // Create reset button - FIXED: Resize first, then redraw
    let resetButton = document.getElementById(`${canvasId}-reset`);
    if (!resetButton) {
        resetButton = document.createElement('button');
        resetButton.id = `${canvasId}-reset`;
        resetButton.textContent = 'Reset';
        resetButton.className = 'plot-button';
        resetButton.style.right = buttonPositions.reset.right;
        resetButton.style.top = buttonPositions.reset.top;
        resetButton.onclick = () => {
            const canvas = document.getElementById(canvasId);
            const wrapper = document.getElementById(`${canvasId}-wrapper`);
            
            // FIRST: Resize canvas to default
            canvas.style.width = '450px';
            canvas.style.height = '400px';
            canvas.width = 900;  // 2x for default sharpness
            canvas.height = 800;
            
            // Remove wrapper height constraint (let CSS handle it)
            wrapper.style.width = '450px';
            wrapper.style.height = '';
            
            // THEN: Reset zoom state (which redraws at NEW size)
            window.resetZoom(canvasId);
        };
        wrapper.appendChild(resetButton);
    }

    // Create theme toggle button
    let themeButton = document.getElementById(`${canvasId}-theme`);
    if (!themeButton) {
        themeButton = document.createElement('button');
        themeButton.id = `${canvasId}-theme`;
        themeButton.className = 'plot-button theme-toggle';
        themeButton.style.right = buttonPositions.theme.right;
        themeButton.style.top = buttonPositions.theme.top;
        themeButton.innerHTML = `
            <svg id="${canvasId}-theme-sun" viewBox="0 0 24 24" style="display: none; width: 16px; height: 16px; fill: currentColor;">
                <path d="M12 2.25a.75.75 0 01.75.75v2.25a.75.75 0 01-1.5 0V3a.75.75 0 01.75-.75zM7.5 12a4.5 4.5 0 119 0 4.5 4.5 0 01-9 0zM18.894 6.166a.75.75 0 00-1.06-1.06l-1.591 1.59a.75.75 0 101.06 1.061l1.591-1.59zM21.75 12a.75.75 0 01-.75.75h-2.25a.75.75 0 010-1.5H21a.75.75 0 01.75.75zM17.834 18.894a.75.75 0 001.06-1.06l-1.59-1.591a.75.75 0 10-1.061 1.06l1.59 1.591zM12 18a.75.75 0 01.75.75V21a.75.75 0 01-1.5 0v-2.25A.75.75 0 0112 18zM7.758 17.303a.75.75 0 00-1.061-1.06l-1.591 1.59a.75.75 0 001.06 1.061l1.591-1.59zM6 12a.75.75 0 01-.75.75H3a.75.75 0 010-1.5h2.25A.75.75 0 016 12zM6.697 7.757a.75.75 0 001.06-1.06l-1.59-1.591a.75.75 0 00-1.061 1.06l1.59 1.591z"/>
            </svg>
            <svg id="${canvasId}-theme-moon" viewBox="0 0 24 24" style="width: 16px; height: 16px; fill: currentColor;">
                <path d="M9.528 1.718a.75.75 0 01.162.819A8.97 8.97 0 009 6a9 9 0 009 9 8.97 8.97 0 003.463-.69.75.75 0 01.981.98 10.503 10.503 0 01-9.694 6.46c-5.799 0-10.5-4.701-10.5-10.5 0-4.368 2.667-8.112 6.46-9.694a.75.75 0 01.818.162z"/>
            </svg>
        `;
        themeButton.onclick = () => window.togglePlotTheme(canvasId);
        wrapper.appendChild(themeButton);
    }

    // Create export button
    let exportButton = document.getElementById(`${canvasId}-export`);
    if (!exportButton) {
        exportButton = document.createElement('button');
        exportButton.id = `${canvasId}-export`;
        exportButton.className = 'plot-button';
        exportButton.style.right = buttonPositions.export.right;
        exportButton.style.top = buttonPositions.export.top;
        exportButton.innerHTML = '📥';
        exportButton.title = 'Export as PNG (4x resolution)';
        exportButton.onclick = () => window.exportPlotAsPNG(canvasId);
        wrapper.appendChild(exportButton);
    }

    // Create expand button
    let expandButton = document.getElementById(`${canvasId}-expand`);
    if (!expandButton) {
        expandButton = document.createElement('button');
        expandButton.id = `${canvasId}-expand`;
        expandButton.className = 'plot-button';
        expandButton.style.right = buttonPositions.expand.right;
        expandButton.style.top = buttonPositions.expand.top;
        expandButton.innerHTML = '⛶';
        expandButton.onclick = () => window.expandPlot(canvasId);
        wrapper.appendChild(expandButton);
    }

    // Create close button
    let closeButton = document.getElementById(`${canvasId}-close`);
    if (!closeButton) {
        closeButton = document.createElement('button');
        closeButton.id = `${canvasId}-close`;
        closeButton.className = 'plot-button';
        closeButton.style.right = buttonPositions.close.right;
        closeButton.style.top = buttonPositions.close.top;
        closeButton.style.display = 'none';
        closeButton.innerHTML = '×';
        closeButton.onclick = () => {
            wrapper.classList.remove('expanded');
            document.getElementById('plot-overlay').classList.remove('active');
            
            const canvas = document.getElementById(canvasId);
            canvas.style.width = '450px';
            canvas.style.height = '400px';
            canvas.width = 900;
            canvas.height = 800;
            
            wrapper.style.width = '450px';
            wrapper.style.height = '';
            
            expandButton.style.display = 'block';
            closeButton.style.display = 'none';
            
            window.redrawPlot(canvasId);
        };
        wrapper.appendChild(closeButton);
    }

    // Create resize handle - FIXED: Positioned at canvas corner
    let resizeHandle = document.getElementById(`${canvasId}-resize`);
    if (!resizeHandle) {
        resizeHandle = document.createElement('div');
        resizeHandle.id = `${canvasId}-resize`;
        resizeHandle.className = 'resize-handle';
        resizeHandle.style.cssText = `
            position: absolute;
            width: 12px;
            height: 12px;
            right: 0;
            bottom: 0;
            background: #444;
            cursor: nwse-resize;
            z-index: 15;
        `;
        // Append to canvas (not wrapper) so it's at canvas corner
        canvas.style.position = 'relative';
        canvas.appendChild(resizeHandle);
        
        resizeHandle.addEventListener('mousedown', function(e) {
            window.startResize(canvasId, e);
        });
    }

    // Update button colors based on theme
    function updateButtonColors() {
        const colors = window.getPlotThemeColors(canvasId);
        const buttons = [resetButton, themeButton, exportButton, expandButton, closeButton];
        buttons.forEach(btn => {
            if (btn) {
                btn.style.background = colors.bgTertiary;
                btn.style.color = colors.textPrimary;
                btn.style.border = `1px solid ${colors.borderColor}`;
            }
        });
        
        if (selectionRect) {
            const colorsTheme = window.getPlotThemeColors(canvasId);
            selectionRect.style.borderColor = colorsTheme.selectionBorder;
            selectionRect.style.background = colorsTheme.selectionBg;
        }
        if (resizeHandle) {
            resizeHandle.style.background = colors.borderColor;
        }
        
        window.redrawPlot(canvasId);
    }
    
    updateButtonColors();

    const observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
            if (mutation.attributeName === "class") {
                updateButtonColors();
            }
        });
    });
    observer.observe(wrapper, { attributes: true });

    let isPanning = false;
    let isBoxSelecting = false;
    let startClient = { x: 0, y: 0 };
    let startRanges = null;
    let parentRect = null;

    function updateParentRect() {
        parentRect = wrapper.getBoundingClientRect();
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
        const cfg = window.getCanvasConfig(canvasId);
        const { top, left } = cfg.margin;
        const plotWidth = canvas.width - left - cfg.margin.right;
        const plotHeight = canvas.height - top - cfg.margin.bottom;
        const dataX = state.current.xMin + ((canvasX - left) / plotWidth) * (state.current.xMax - state.current.xMin);
        const dataY = state.current.yMax - ((canvasY - top) / plotHeight) * (state.current.yMax - state.current.yMin);
        return { x: dataX, y: dataY };
    }

    function redraw() {
        window.redrawPlot(canvasId);
    }

    canvas.addEventListener('mousedown', function(e) {
        if (e.target.classList.contains('plot-button') || 
            e.target.classList.contains('resize-handle') ||
            (e.target.id && (e.target.id.includes('-theme') || 
                             e.target.id.includes('-export') || 
                             e.target.id.includes('-expand') || 
                             e.target.id.includes('-reset') || 
                             e.target.id.includes('-close')))) {
            return;
        }
        
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
            const colorsTheme = window.getPlotThemeColors(canvasId);
            selectionRect.style.display = 'block';
            selectionRect.style.borderColor = colorsTheme.selectionBorder;
            selectionRect.style.background = colorsTheme.selectionBg;
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

            const cfg = window.getCanvasConfig(canvasId);
            const { top, left } = cfg.margin;
            const plotWidth = canvas.width - left - cfg.margin.right;
            const plotHeight = canvas.height - top - cfg.margin.bottom;

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

            // Maintain aspect ratio
            const canvasAspect = canvas.width / canvas.height;
            const dataAspect = (xMax - xMin) / (yMax - yMin);
            
            let paddingX = 0.05 * (xMax - xMin);
            let paddingY = 0.05 * (yMax - yMin);
            
            if (dataAspect > canvasAspect) {
                const requiredHeight = (xMax - xMin + 2 * paddingX) / canvasAspect;
                paddingY = (requiredHeight - (yMax - yMin)) / 2;
            } else {
                const requiredWidth = (yMax - yMin + 2 * paddingY) * canvasAspect;
                paddingX = (requiredWidth - (xMax - xMin)) / 2;
            }

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
// EXPAND PLOT - FIXED: 3x sharpness for expanded
// =============================================
window.expandPlot = function(canvasId) {
    const canvas = document.getElementById(canvasId);
    const wrapper = document.getElementById(`${canvasId}-wrapper`);
    const overlay = document.getElementById('plot-overlay');
    const expandBtn = document.getElementById(`${canvasId}-expand`);
    const closeBtn = document.getElementById(`${canvasId}-close`);
    
    const isExpanded = wrapper.classList.contains('expanded');
    
    if (isExpanded) {
        wrapper.classList.remove('expanded');
        overlay.classList.remove('active');
        
        canvas.style.width = '450px';
        canvas.style.height = '400px';
        canvas.width = 900;  // 2x for default
        canvas.height = 800;
        
        wrapper.style.width = '450px';
        wrapper.style.height = '';
        
        expandBtn.style.display = 'block';
        closeBtn.style.display = 'none';
    } else {
        wrapper.classList.add('expanded');
        overlay.classList.add('active');
        
        const newWidth = Math.min(window.innerWidth * 0.8, 1200);
        const newHeight = Math.min(window.innerHeight * 0.8, 900);
        
        canvas.style.width = `${newWidth}px`;
        canvas.style.height = `${newHeight}px`;
        canvas.width = newWidth * 3;  // FIXED: 3x for sharper expanded
        canvas.height = newHeight * 3;
        
        wrapper.style.width = `${newWidth}px`;
        wrapper.style.height = '';
        
        expandBtn.style.display = 'none';
        closeBtn.style.display = 'block';
    }
    
    window.redrawPlot(canvasId);
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
// TOGGLE PLOT THEME
// =============================================
window.togglePlotTheme = function(canvasId) {
    const wrapper = document.getElementById(`${canvasId}-wrapper`);
    const currentTheme = wrapper.classList.contains('light-mode') ? 'light' : 'dark';
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    wrapper.classList.toggle('light-mode');
    
    const iconSun = document.getElementById(`${canvasId}-theme-sun`);
    const iconMoon = document.getElementById(`${canvasId}-theme-moon`);
    if (iconSun && iconMoon) {
        iconSun.style.display = newTheme === 'light' ? 'block' : 'none';
        iconMoon.style.display = newTheme === 'light' ? 'none' : 'block';
    }
    
    window.redrawPlot(canvasId);
};

// =============================================
// INITIALIZE
// =============================================
document.addEventListener('DOMContentLoaded', function() {
    window.setupGlobalResizeHandlers();
    window.setupCanvasInteractions('ev-plot');
    window.setupCanvasInteractions('pv-plot');
    
    // Add CSS for buttons and resize handle
    const style = document.createElement('style');
    style.textContent = `
        .plot-button {
            position: absolute;
            z-index: 10;
            background: #2d2d2d;
            color: #e0e0e0;
            border: 1px solid #444;
            border-radius: 4px;
            padding: 4px 8px;
            cursor: pointer;
            font-size: 12px;
            min-width: 30px;
        }
        .plot-button:hover {
            background: #3a3a3a;
        }
        .plot-wrapper.light-mode .plot-button {
            background: #e0e0e0;
            color: #121212;
            border-color: #ccc;
        }
        .plot-wrapper.light-mode .plot-button:hover {
            background: #cccccc;
        }
        .resize-handle {
            position: absolute;
            width: 12px;
            height: 12px;
            right: 0;
            bottom: 0;
            background: #444;
            cursor: nwse-resize;
            z-index: 15;
        }
        .plot-wrapper.light-mode .resize-handle {
            background: #ccc;
        }
        .plot-wrapper {
            transition: width 0.2s ease, height 0.2s ease;
        }
        canvas {
            max-width: 100%;
        }
    `;
    document.head.appendChild(style);
    
    // FIXED: Window resize handler for expanded plots
    window.addEventListener('resize', function() {
        ['ev-plot', 'pv-plot'].forEach(id => {
            const wrapper = document.getElementById(`${id}-wrapper`);
            if (wrapper && wrapper.classList.contains('expanded')) {
                const canvas = document.getElementById(id);
                if (canvas) {
                    const newWidth = Math.min(window.innerWidth * 0.8, 1200);
                    const newHeight = Math.min(window.innerHeight * 0.8, 900);
                    
                    canvas.style.width = `${newWidth}px`;
                    canvas.style.height = `${newHeight}px`;
                    canvas.width = newWidth * 3;  // 3x for sharpness
                    canvas.height = newHeight * 3;
                    
                    wrapper.style.width = `${newWidth}px`;
                    
                    window.redrawPlot(id);
                }
            }
        });
    });
});
