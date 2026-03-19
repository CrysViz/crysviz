emcc --no-entry --bind -g3 -lembind -sALLOW_MEMORY_GROWTH=1  -sMODULARIZE=1  -sEXPORT_NAME="'MarchCubes'" -sEXPORT_ES6=1 -sEXPORTED_RUNTIME_METHODS=HEAPF32,HEAPF64 marching_cubes.cpp -o MarchCubes.js
