// gpu-esm.js — re-export everything from window.GPU as named ES exports

export function getGPU() {
    return new window.GPU();
}
export function GPUInput(array, size=null) {
    if (!size) {
        return window.GPU.input(array);
    }
    else {
        return window.GPU.input(array, size);
    }
}
//const { GPU, input, utils, Texture, plugins } = window.GPU;
//export { GPU, input, utils, Texture, plugins };
// add any others you need from the full list above