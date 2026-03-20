emcc --no-entry -O2 --bind -lembind -sALLOW_MEMORY_GROWTH=1 -sMODULARIZE=1  -sEXPORT_NAME="'MarchCubes'" -sEXPORT_ES6=1 -sEXPORTED_RUNTIME_METHODS=HEAPF32,HEAPF64 -sMAXIMUM_MEMORY=4294967296 marching_cubes.cpp -o MarchCubes.js

emcc --no-entry -gsource-map -fsanitize=address --bind -lembind -sALLOW_MEMORY_GROWTH=1 -sMODULARIZE=1  -sEXPORT_NAME="'MarchCubes'" -sEXPORT_ES6=1 -sMAXIMUM_MEMORY=4294967296 -sEXPORTED_RUNTIME_METHODS=HEAPF32,HEAPF64 -pthread -sPTHREAD_POOL_SIZE=navigator.hardwareConcurrency -sALLOW_BLOCKING_ON_MAIN_THREAD=1 marching_cubes_parallel.cpp -o MarchCubesPar.js
