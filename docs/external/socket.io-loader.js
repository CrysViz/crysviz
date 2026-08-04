// Keep the raw vendored Socket.IO module outside the first-party type-check
// graph. The browser still loads the exact local ESM asset when the optional
// backend panel is activated.
let socketIOModulePromise;
const socketIOAsset = './socket.io/socket.io.esm.min.js';

export async function loadSocketIO() {
  socketIOModulePromise ??= import(socketIOAsset);
  return socketIOModulePromise;
}
