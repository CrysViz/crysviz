// gpu-esm.js — re-export everything from window.GPU as named ES exports
const { GPU, input, utils, Texture, plugins } = window.GPU;
export { GPU, input, utils, Texture, plugins };
// add any others you need from the full list above