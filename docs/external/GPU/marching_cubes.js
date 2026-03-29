import { GPU, input } from "./gpu-esm.js";
// imported in index.html, since no apparent support for ES6 modules in GPU.js as of now
const gpu = new GPU();

const edgeTable = new Uint16Array([
	0x0, 0x109, 0x203, 0x30a, 0x406, 0x50f, 0x605, 0x70c,
	0x80c, 0x905, 0xa0f, 0xb06, 0xc0a, 0xd03, 0xe09, 0xf00,
	0x190, 0x99, 0x393, 0x29a, 0x596, 0x49f, 0x795, 0x69c,
	0x99c, 0x895, 0xb9f, 0xa96, 0xd9a, 0xc93, 0xf99, 0xe90,
	0x230, 0x339, 0x33, 0x13a, 0x636, 0x73f, 0x435, 0x53c,
	0xa3c, 0xb35, 0x83f, 0x936, 0xe3a, 0xf33, 0xc39, 0xd30,
	0x3a0, 0x2a9, 0x1a3, 0xaa, 0x7a6, 0x6af, 0x5a5, 0x4ac,
	0xbac, 0xaa5, 0x9af, 0x8a6, 0xfaa, 0xea3, 0xda9, 0xca0,
	0x460, 0x569, 0x663, 0x76a, 0x66, 0x16f, 0x265, 0x36c,
	0xc6c, 0xd65, 0xe6f, 0xf66, 0x86a, 0x963, 0xa69, 0xb60,
	0x5f0, 0x4f9, 0x7f3, 0x6fa, 0x1f6, 0xff, 0x3f5, 0x2fc,
	0xdfc, 0xcf5, 0xfff, 0xef6, 0x9fa, 0x8f3, 0xbf9, 0xaf0,
	0x650, 0x759, 0x453, 0x55a, 0x256, 0x35f, 0x55, 0x15c,
	0xe5c, 0xf55, 0xc5f, 0xd56, 0xa5a, 0xb53, 0x859, 0x950,
	0x7c0, 0x6c9, 0x5c3, 0x4ca, 0x3c6, 0x2cf, 0x1c5, 0xcc,
	0xfcc, 0xec5, 0xdcf, 0xcc6, 0xbca, 0xac3, 0x9c9, 0x8c0,
	0x8c0, 0x9c9, 0xac3, 0xbca, 0xcc6, 0xdcf, 0xec5, 0xfcc,
	0xcc, 0x1c5, 0x2cf, 0x3c6, 0x4ca, 0x5c3, 0x6c9, 0x7c0,
	0x950, 0x859, 0xb53, 0xa5a, 0xd56, 0xc5f, 0xf55, 0xe5c,
	0x15c, 0x55, 0x35f, 0x256, 0x55a, 0x453, 0x759, 0x650,
	0xaf0, 0xbf9, 0x8f3, 0x9fa, 0xef6, 0xfff, 0xcf5, 0xdfc,
	0x2fc, 0x3f5, 0xff, 0x1f6, 0x6fa, 0x7f3, 0x4f9, 0x5f0,
	0xb60, 0xa69, 0x963, 0x86a, 0xf66, 0xe6f, 0xd65, 0xc6c,
	0x36c, 0x265, 0x16f, 0x66, 0x76a, 0x663, 0x569, 0x460,
	0xca0, 0xda9, 0xea3, 0xfaa, 0x8a6, 0x9af, 0xaa5, 0xbac,
	0x4ac, 0x5a5, 0x6af, 0x7a6, 0xaa, 0x1a3, 0x2a9, 0x3a0,
	0xd30, 0xc39, 0xf33, 0xe3a, 0x936, 0x83f, 0xb35, 0xa3c,
	0x53c, 0x435, 0x73f, 0x636, 0x13a, 0x33, 0x339, 0x230,
	0xe90, 0xf99, 0xc93, 0xd9a, 0xa96, 0xb9f, 0x895, 0x99c,
	0x69c, 0x795, 0x49f, 0x596, 0x29a, 0x393, 0x99, 0x190,
	0xf00, 0xe09, 0xd03, 0xc0a, 0xb06, 0xa0f, 0x905, 0x80c,
	0x70c, 0x605, 0x50f, 0x406, 0x30a, 0x203, 0x109, 0x0
]);

// each row in this file represents the edges, in order, to be processed for each of the 256 possible cube configurations.
// The value 255 is used to indicate the end of the list of edges to process for a given configuration.
// It is a flattened 256x15 array
const triTable = new Uint8Array([
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      0,   8,   3, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      0,   1,   9, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      1,   8,   3,   9,   8,   1, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      1,   2,  10, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      0,   8,   3,   1,   2,  10, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      9,   2,  10,   0,   2,   9, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      2,   8,   3,   2,  10,   8,  10,   9,   8, 255, 255, 255, 255, 255, 255,
      3,  11,   2, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      0,  11,   2,   8,  11,   0, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      1,   9,   0,   2,   3,  11, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      1,  11,   2,   1,   9,  11,   9,   8,  11, 255, 255, 255, 255, 255, 255,
      3,  10,   1,  11,  10,   3, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      0,  10,   1,   0,   8,  10,   8,  11,  10, 255, 255, 255, 255, 255, 255,
      3,   9,   0,   3,  11,   9,  11,  10,   9, 255, 255, 255, 255, 255, 255,
      9,   8,  10,  10,   8,  11, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      4,   7,   8, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      4,   3,   0,   7,   3,   4, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      0,   1,   9,   8,   4,   7, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      4,   1,   9,   4,   7,   1,   7,   3,   1, 255, 255, 255, 255, 255, 255,
      1,   2,  10,   8,   4,   7, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      3,   4,   7,   3,   0,   4,   1,   2,  10, 255, 255, 255, 255, 255, 255,
      9,   2,  10,   9,   0,   2,   8,   4,   7, 255, 255, 255, 255, 255, 255,
      2,  10,   9,   2,   9,   7,   2,   7,   3,   7,   9,   4, 255, 255, 255,
      8,   4,   7,   3,  11,   2, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     11,   4,   7,  11,   2,   4,   2,   0,   4, 255, 255, 255, 255, 255, 255,
      9,   0,   1,   8,   4,   7,   2,   3,  11, 255, 255, 255, 255, 255, 255,
      4,   7,  11,   9,   4,  11,   9,  11,   2,   9,   2,   1, 255, 255, 255,
      3,  10,   1,   3,  11,  10,   7,   8,   4, 255, 255, 255, 255, 255, 255,
      1,  11,  10,   1,   4,  11,   1,   0,   4,   7,  11,   4, 255, 255, 255,
      4,   7,   8,   9,   0,  11,   9,  11,  10,  11,   0,   3, 255, 255, 255,
      4,   7,  11,   4,  11,   9,   9,  11,  10, 255, 255, 255, 255, 255, 255,
      9,   5,   4, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      9,   5,   4,   0,   8,   3, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      0,   5,   4,   1,   5,   0, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      8,   5,   4,   8,   3,   5,   3,   1,   5, 255, 255, 255, 255, 255, 255,
      1,   2,  10,   9,   5,   4, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      3,   0,   8,   1,   2,  10,   4,   9,   5, 255, 255, 255, 255, 255, 255,
      5,   2,  10,   5,   4,   2,   4,   0,   2, 255, 255, 255, 255, 255, 255,
      2,  10,   5,   3,   2,   5,   3,   5,   4,   3,   4,   8, 255, 255, 255,
      9,   5,   4,   2,   3,  11, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      0,  11,   2,   0,   8,  11,   4,   9,   5, 255, 255, 255, 255, 255, 255,
      0,   5,   4,   0,   1,   5,   2,   3,  11, 255, 255, 255, 255, 255, 255,
      2,   1,   5,   2,   5,   8,   2,   8,  11,   4,   8,   5, 255, 255, 255,
     10,   3,  11,  10,   1,   3,   9,   5,   4, 255, 255, 255, 255, 255, 255,
      4,   9,   5,   0,   8,   1,   8,  10,   1,   8,  11,  10, 255, 255, 255,
      5,   4,   0,   5,   0,  11,   5,  11,  10,  11,   0,   3, 255, 255, 255,
      5,   4,   8,   5,   8,  10,  10,   8,  11, 255, 255, 255, 255, 255, 255,
      9,   7,   8,   5,   7,   9, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      9,   3,   0,   9,   5,   3,   5,   7,   3, 255, 255, 255, 255, 255, 255,
      0,   7,   8,   0,   1,   7,   1,   5,   7, 255, 255, 255, 255, 255, 255,
      1,   5,   3,   3,   5,   7, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      9,   7,   8,   9,   5,   7,  10,   1,   2, 255, 255, 255, 255, 255, 255,
     10,   1,   2,   9,   5,   0,   5,   3,   0,   5,   7,   3, 255, 255, 255,
      8,   0,   2,   8,   2,   5,   8,   5,   7,  10,   5,   2, 255, 255, 255,
      2,  10,   5,   2,   5,   3,   3,   5,   7, 255, 255, 255, 255, 255, 255,
      7,   9,   5,   7,   8,   9,   3,  11,   2, 255, 255, 255, 255, 255, 255,
      9,   5,   7,   9,   7,   2,   9,   2,   0,   2,   7,  11, 255, 255, 255,
      2,   3,  11,   0,   1,   8,   1,   7,   8,   1,   5,   7, 255, 255, 255,
     11,   2,   1,  11,   1,   7,   7,   1,   5, 255, 255, 255, 255, 255, 255,
      9,   5,   8,   8,   5,   7,  10,   1,   3,  10,   3,  11, 255, 255, 255,
      5,   7,   0,   5,   0,   9,   7,  11,   0,   1,   0,  10,  11,  10,   0,
     11,  10,   0,  11,   0,   3,  10,   5,   0,   8,   0,   7,   5,   7,   0,
     11,  10,   5,   7,  11,   5, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     10,   6,   5, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      0,   8,   3,   5,  10,   6, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      9,   0,   1,   5,  10,   6, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      1,   8,   3,   1,   9,   8,   5,  10,   6, 255, 255, 255, 255, 255, 255,
      1,   6,   5,   2,   6,   1, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      1,   6,   5,   1,   2,   6,   3,   0,   8, 255, 255, 255, 255, 255, 255,
      9,   6,   5,   9,   0,   6,   0,   2,   6, 255, 255, 255, 255, 255, 255,
      5,   9,   8,   5,   8,   2,   5,   2,   6,   3,   2,   8, 255, 255, 255,
      2,   3,  11,  10,   6,   5, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     11,   0,   8,  11,   2,   0,  10,   6,   5, 255, 255, 255, 255, 255, 255,
      0,   1,   9,   2,   3,  11,   5,  10,   6, 255, 255, 255, 255, 255, 255,
      5,  10,   6,   1,   9,   2,   9,  11,   2,   9,   8,  11, 255, 255, 255,
      6,   3,  11,   6,   5,   3,   5,   1,   3, 255, 255, 255, 255, 255, 255,
      0,   8,  11,   0,  11,   5,   0,   5,   1,   5,  11,   6, 255, 255, 255,
      3,  11,   6,   0,   3,   6,   0,   6,   5,   0,   5,   9, 255, 255, 255,
      6,   5,   9,   6,   9,  11,  11,   9,   8, 255, 255, 255, 255, 255, 255,
      5,  10,   6,   4,   7,   8, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      4,   3,   0,   4,   7,   3,   6,   5,  10, 255, 255, 255, 255, 255, 255,
      1,   9,   0,   5,  10,   6,   8,   4,   7, 255, 255, 255, 255, 255, 255,
     10,   6,   5,   1,   9,   7,   1,   7,   3,   7,   9,   4, 255, 255, 255,
      6,   1,   2,   6,   5,   1,   4,   7,   8, 255, 255, 255, 255, 255, 255,
      1,   2,   5,   5,   2,   6,   3,   0,   4,   3,   4,   7, 255, 255, 255,
      8,   4,   7,   9,   0,   5,   0,   6,   5,   0,   2,   6, 255, 255, 255,
      7,   3,   9,   7,   9,   4,   3,   2,   9,   5,   9,   6,   2,   6,   9,
      3,  11,   2,   7,   8,   4,  10,   6,   5, 255, 255, 255, 255, 255, 255,
      5,  10,   6,   4,   7,   2,   4,   2,   0,   2,   7,  11, 255, 255, 255,
      0,   1,   9,   4,   7,   8,   2,   3,  11,   5,  10,   6, 255, 255, 255,
      9,   2,   1,   9,  11,   2,   9,   4,  11,   7,  11,   4,   5,  10,   6,
      8,   4,   7,   3,  11,   5,   3,   5,   1,   5,  11,   6, 255, 255, 255,
      5,   1,  11,   5,  11,   6,   1,   0,  11,   7,  11,   4,   0,   4,  11,
      0,   5,   9,   0,   6,   5,   0,   3,   6,  11,   6,   3,   8,   4,   7,
      6,   5,   9,   6,   9,  11,   4,   7,   9,   7,  11,   9, 255, 255, 255,
     10,   4,   9,   6,   4,  10, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      4,  10,   6,   4,   9,  10,   0,   8,   3, 255, 255, 255, 255, 255, 255,
     10,   0,   1,  10,   6,   0,   6,   4,   0, 255, 255, 255, 255, 255, 255,
      8,   3,   1,   8,   1,   6,   8,   6,   4,   6,   1,  10, 255, 255, 255,
      1,   4,   9,   1,   2,   4,   2,   6,   4, 255, 255, 255, 255, 255, 255,
      3,   0,   8,   1,   2,   9,   2,   4,   9,   2,   6,   4, 255, 255, 255,
      0,   2,   4,   4,   2,   6, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      8,   3,   2,   8,   2,   4,   4,   2,   6, 255, 255, 255, 255, 255, 255,
     10,   4,   9,  10,   6,   4,  11,   2,   3, 255, 255, 255, 255, 255, 255,
      0,   8,   2,   2,   8,  11,   4,   9,  10,   4,  10,   6, 255, 255, 255,
      3,  11,   2,   0,   1,   6,   0,   6,   4,   6,   1,  10, 255, 255, 255,
      6,   4,   1,   6,   1,  10,   4,   8,   1,   2,   1,  11,   8,  11,   1,
      9,   6,   4,   9,   3,   6,   9,   1,   3,  11,   6,   3, 255, 255, 255,
      8,  11,   1,   8,   1,   0,  11,   6,   1,   9,   1,   4,   6,   4,   1,
      3,  11,   6,   3,   6,   0,   0,   6,   4, 255, 255, 255, 255, 255, 255,
      6,   4,   8,  11,   6,   8, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      7,  10,   6,   7,   8,  10,   8,   9,  10, 255, 255, 255, 255, 255, 255,
      0,   7,   3,   0,  10,   7,   0,   9,  10,   6,   7,  10, 255, 255, 255,
     10,   6,   7,   1,  10,   7,   1,   7,   8,   1,   8,   0, 255, 255, 255,
     10,   6,   7,  10,   7,   1,   1,   7,   3, 255, 255, 255, 255, 255, 255,
      1,   2,   6,   1,   6,   8,   1,   8,   9,   8,   6,   7, 255, 255, 255,
      2,   6,   9,   2,   9,   1,   6,   7,   9,   0,   9,   3,   7,   3,   9,
      7,   8,   0,   7,   0,   6,   6,   0,   2, 255, 255, 255, 255, 255, 255,
      7,   3,   2,   6,   7,   2, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      2,   3,  11,  10,   6,   8,  10,   8,   9,   8,   6,   7, 255, 255, 255,
      2,   0,   7,   2,   7,  11,   0,   9,   7,   6,   7,  10,   9,  10,   7,
      1,   8,   0,   1,   7,   8,   1,  10,   7,   6,   7,  10,   2,   3,  11,
     11,   2,   1,  11,   1,   7,  10,   6,   1,   6,   7,   1, 255, 255, 255,
      8,   9,   6,   8,   6,   7,   9,   1,   6,  11,   6,   3,   1,   3,   6,
      0,   9,   1,  11,   6,   7, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      7,   8,   0,   7,   0,   6,   3,  11,   0,  11,   6,   0, 255, 255, 255,
      7,  11,   6, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      7,   6,  11, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      3,   0,   8,  11,   7,   6, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      0,   1,   9,  11,   7,   6, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      8,   1,   9,   8,   3,   1,  11,   7,   6, 255, 255, 255, 255, 255, 255,
     10,   1,   2,   6,  11,   7, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      1,   2,  10,   3,   0,   8,   6,  11,   7, 255, 255, 255, 255, 255, 255,
      2,   9,   0,   2,  10,   9,   6,  11,   7, 255, 255, 255, 255, 255, 255,
      6,  11,   7,   2,  10,   3,  10,   8,   3,  10,   9,   8, 255, 255, 255,
      7,   2,   3,   6,   2,   7, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      7,   0,   8,   7,   6,   0,   6,   2,   0, 255, 255, 255, 255, 255, 255,
      2,   7,   6,   2,   3,   7,   0,   1,   9, 255, 255, 255, 255, 255, 255,
      1,   6,   2,   1,   8,   6,   1,   9,   8,   8,   7,   6, 255, 255, 255,
     10,   7,   6,  10,   1,   7,   1,   3,   7, 255, 255, 255, 255, 255, 255,
     10,   7,   6,   1,   7,  10,   1,   8,   7,   1,   0,   8, 255, 255, 255,
      0,   3,   7,   0,   7,  10,   0,  10,   9,   6,  10,   7, 255, 255, 255,
      7,   6,  10,   7,  10,   8,   8,  10,   9, 255, 255, 255, 255, 255, 255,
      6,   8,   4,  11,   8,   6, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      3,   6,  11,   3,   0,   6,   0,   4,   6, 255, 255, 255, 255, 255, 255,
      8,   6,  11,   8,   4,   6,   9,   0,   1, 255, 255, 255, 255, 255, 255,
      9,   4,   6,   9,   6,   3,   9,   3,   1,  11,   3,   6, 255, 255, 255,
      6,   8,   4,   6,  11,   8,   2,  10,   1, 255, 255, 255, 255, 255, 255,
      1,   2,  10,   3,   0,  11,   0,   6,  11,   0,   4,   6, 255, 255, 255,
      4,  11,   8,   4,   6,  11,   0,   2,   9,   2,  10,   9, 255, 255, 255,
     10,   9,   3,  10,   3,   2,   9,   4,   3,  11,   3,   6,   4,   6,   3,
      8,   2,   3,   8,   4,   2,   4,   6,   2, 255, 255, 255, 255, 255, 255,
      0,   4,   2,   4,   6,   2, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      1,   9,   0,   2,   3,   4,   2,   4,   6,   4,   3,   8, 255, 255, 255,
      1,   9,   4,   1,   4,   2,   2,   4,   6, 255, 255, 255, 255, 255, 255,
      8,   1,   3,   8,   6,   1,   8,   4,   6,   6,  10,   1, 255, 255, 255,
     10,   1,   0,  10,   0,   6,   6,   0,   4, 255, 255, 255, 255, 255, 255,
      4,   6,   3,   4,   3,   8,   6,  10,   3,   0,   3,   9,  10,   9,   3,
     10,   9,   4,   6,  10,   4, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      4,   9,   5,   7,   6,  11, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      0,   8,   3,   4,   9,   5,  11,   7,   6, 255, 255, 255, 255, 255, 255,
      5,   0,   1,   5,   4,   0,   7,   6,  11, 255, 255, 255, 255, 255, 255,
     11,   7,   6,   8,   3,   4,   3,   5,   4,   3,   1,   5, 255, 255, 255,
      9,   5,   4,  10,   1,   2,   7,   6,  11, 255, 255, 255, 255, 255, 255,
      6,  11,   7,   1,   2,  10,   0,   8,   3,   4,   9,   5, 255, 255, 255,
      7,   6,  11,   5,   4,  10,   4,   2,  10,   4,   0,   2, 255, 255, 255,
      3,   4,   8,   3,   5,   4,   3,   2,   5,  10,   5,   2,  11,   7,   6,
      7,   2,   3,   7,   6,   2,   5,   4,   9, 255, 255, 255, 255, 255, 255,
      9,   5,   4,   0,   8,   6,   0,   6,   2,   6,   8,   7, 255, 255, 255,
      3,   6,   2,   3,   7,   6,   1,   5,   0,   5,   4,   0, 255, 255, 255,
      6,   2,   8,   6,   8,   7,   2,   1,   8,   4,   8,   5,   1,   5,   8,
      9,   5,   4,  10,   1,   6,   1,   7,   6,   1,   3,   7, 255, 255, 255,
      1,   6,  10,   1,   7,   6,   1,   0,   7,   8,   7,   0,   9,   5,   4,
      4,   0,  10,   4,  10,   5,   0,   3,  10,   6,  10,   7,   3,   7,  10,
      7,   6,  10,   7,  10,   8,   5,   4,  10,   4,   8,  10, 255, 255, 255,
      6,   9,   5,   6,  11,   9,  11,   8,   9, 255, 255, 255, 255, 255, 255,
      3,   6,  11,   0,   6,   3,   0,   5,   6,   0,   9,   5, 255, 255, 255,
      0,  11,   8,   0,   5,  11,   0,   1,   5,   5,   6,  11, 255, 255, 255,
      6,  11,   3,   6,   3,   5,   5,   3,   1, 255, 255, 255, 255, 255, 255,
      1,   2,  10,   9,   5,  11,   9,  11,   8,  11,   5,   6, 255, 255, 255,
      0,  11,   3,   0,   6,  11,   0,   9,   6,   5,   6,   9,   1,   2,  10,
     11,   8,   5,  11,   5,   6,   8,   0,   5,  10,   5,   2,   0,   2,   5,
      6,  11,   3,   6,   3,   5,   2,  10,   3,  10,   5,   3, 255, 255, 255,
      5,   8,   9,   5,   2,   8,   5,   6,   2,   3,   8,   2, 255, 255, 255,
      9,   5,   6,   9,   6,   0,   0,   6,   2, 255, 255, 255, 255, 255, 255,
      1,   5,   8,   1,   8,   0,   5,   6,   8,   3,   8,   2,   6,   2,   8,
      1,   5,   6,   2,   1,   6, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      1,   3,   6,   1,   6,  10,   3,   8,   6,   5,   6,   9,   8,   9,   6,
     10,   1,   0,  10,   0,   6,   9,   5,   0,   5,   6,   0, 255, 255, 255,
      0,   3,   8,   5,   6,  10, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     10,   5,   6, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     11,   5,  10,   7,   5,  11, 255, 255, 255, 255, 255, 255, 255, 255, 255,
     11,   5,  10,  11,   7,   5,   8,   3,   0, 255, 255, 255, 255, 255, 255,
      5,  11,   7,   5,  10,  11,   1,   9,   0, 255, 255, 255, 255, 255, 255,
     10,   7,   5,  10,  11,   7,   9,   8,   1,   8,   3,   1, 255, 255, 255,
     11,   1,   2,  11,   7,   1,   7,   5,   1, 255, 255, 255, 255, 255, 255,
      0,   8,   3,   1,   2,   7,   1,   7,   5,   7,   2,  11, 255, 255, 255,
      9,   7,   5,   9,   2,   7,   9,   0,   2,   2,  11,   7, 255, 255, 255,
      7,   5,   2,   7,   2,  11,   5,   9,   2,   3,   2,   8,   9,   8,   2,
      2,   5,  10,   2,   3,   5,   3,   7,   5, 255, 255, 255, 255, 255, 255,
      8,   2,   0,   8,   5,   2,   8,   7,   5,  10,   2,   5, 255, 255, 255,
      9,   0,   1,   5,  10,   3,   5,   3,   7,   3,  10,   2, 255, 255, 255,
      9,   8,   2,   9,   2,   1,   8,   7,   2,  10,   2,   5,   7,   5,   2,
      1,   3,   5,   3,   7,   5, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      0,   8,   7,   0,   7,   1,   1,   7,   5, 255, 255, 255, 255, 255, 255,
      9,   0,   3,   9,   3,   5,   5,   3,   7, 255, 255, 255, 255, 255, 255,
      9,   8,   7,   5,   9,   7, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      5,   8,   4,   5,  10,   8,  10,  11,   8, 255, 255, 255, 255, 255, 255,
      5,   0,   4,   5,  11,   0,   5,  10,  11,  11,   3,   0, 255, 255, 255,
      0,   1,   9,   8,   4,  10,   8,  10,  11,  10,   4,   5, 255, 255, 255,
     10,  11,   4,  10,   4,   5,  11,   3,   4,   9,   4,   1,   3,   1,   4,
      2,   5,   1,   2,   8,   5,   2,  11,   8,   4,   5,   8, 255, 255, 255,
      0,   4,  11,   0,  11,   3,   4,   5,  11,   2,  11,   1,   5,   1,  11,
      0,   2,   5,   0,   5,   9,   2,  11,   5,   4,   5,   8,  11,   8,   5,
      9,   4,   5,   2,  11,   3, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      2,   5,  10,   3,   5,   2,   3,   4,   5,   3,   8,   4, 255, 255, 255,
      5,  10,   2,   5,   2,   4,   4,   2,   0, 255, 255, 255, 255, 255, 255,
      3,  10,   2,   3,   5,  10,   3,   8,   5,   4,   5,   8,   0,   1,   9,
      5,  10,   2,   5,   2,   4,   1,   9,   2,   9,   4,   2, 255, 255, 255,
      8,   4,   5,   8,   5,   3,   3,   5,   1, 255, 255, 255, 255, 255, 255,
      0,   4,   5,   1,   0,   5, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      8,   4,   5,   8,   5,   3,   9,   0,   5,   0,   3,   5, 255, 255, 255,
      9,   4,   5, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      4,  11,   7,   4,   9,  11,   9,  10,  11, 255, 255, 255, 255, 255, 255,
      0,   8,   3,   4,   9,   7,   9,  11,   7,   9,  10,  11, 255, 255, 255,
      1,  10,  11,   1,  11,   4,   1,   4,   0,   7,   4,  11, 255, 255, 255,
      3,   1,   4,   3,   4,   8,   1,  10,   4,   7,   4,  11,  10,  11,   4,
      4,  11,   7,   9,  11,   4,   9,   2,  11,   9,   1,   2, 255, 255, 255,
      9,   7,   4,   9,  11,   7,   9,   1,  11,   2,  11,   1,   0,   8,   3,
     11,   7,   4,  11,   4,   2,   2,   4,   0, 255, 255, 255, 255, 255, 255,
     11,   7,   4,  11,   4,   2,   8,   3,   4,   3,   2,   4, 255, 255, 255,
      2,   9,  10,   2,   7,   9,   2,   3,   7,   7,   4,   9, 255, 255, 255,
      9,  10,   7,   9,   7,   4,  10,   2,   7,   8,   7,   0,   2,   0,   7,
      3,   7,  10,   3,  10,   2,   7,   4,  10,   1,  10,   0,   4,   0,  10,
      1,  10,   2,   8,   7,   4, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      4,   9,   1,   4,   1,   7,   7,   1,   3, 255, 255, 255, 255, 255, 255,
      4,   9,   1,   4,   1,   7,   0,   8,   1,   8,   7,   1, 255, 255, 255,
      4,   0,   3,   7,   4,   3, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      4,   8,   7, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      9,  10,   8,  10,  11,   8, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      3,   0,   9,   3,   9,  11,  11,   9,  10, 255, 255, 255, 255, 255, 255,
      0,   1,  10,   0,  10,   8,   8,  10,  11, 255, 255, 255, 255, 255, 255,
      3,   1,  10,  11,   3,  10, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      1,   2,  11,   1,  11,   9,   9,  11,   8, 255, 255, 255, 255, 255, 255,
      3,   0,   9,   3,   9,  11,   1,   2,   9,   2,  11,   9, 255, 255, 255,
      0,   2,  11,   8,   0,  11, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      3,   2,  11, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      2,   3,   8,   2,   8,  10,  10,   8,   9, 255, 255, 255, 255, 255, 255,
      9,  10,   2,   0,   9,   2, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      2,   3,   8,   2,   8,  10,   0,   1,   8,   1,  10,   8, 255, 255, 255,
      1,  10,   2, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      1,   3,   8,   9,   1,   8, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      0,   9,   1, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
      0,   3,   8, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255
]);

const triTableCount = new Uint8Array([
    0,   1,   1,   2,   1,   2,   2,   3,   1,   2,   2,   3,   2,   3,   3,   2, 
    1,   2,   2,   3,   2,   3,   3,   4,   2,   3,   3,   4,   3,   4,   4,   3, 
    1,   2,   2,   3,   2,   3,   3,   4,   2,   3,   3,   4,   3,   4,   4,   3,
    2,   3,   3,   2,   3,   4,   4,   3,   3,   4,   4,   3,   4,   5,   5,   2,
    1,   2,   2,   3,   2,   3,   3,   4,   2,   3,   3,   4,   3,   4,   4,   3,
    2,   3,   3,   4,   3,   4,   4,   5,   3,   4,   4,   5,   4,   5,   5,   4,
    2,   3,   3,   4,   3,   4,   2,   3,   3,   4,   4,   5,   4,   5,   3,   2,
    3,   4,   4,   3,   4,   5,   3,   2,   4,   5,   5,   4,   5,   2,   4,   1,
    1,   2,   2,   3,   2,   3,   3,   4,   2,   3,   3,   4,   3,   4,   4,   3,
    2,   3,   3,   4,   3,   4,   4,   5,   3,   2,   4,   3,   4,   3,   5,   2,
    2,   3,   3,   4,   3,   4,   4,   5,   3,   4,   4,   5,   4,   5,   5,   4,
    3,   4,   4,   3,   4,   5,   5,   4,   4,   3,   5,   2,   5,   4,   2,   1,
    2,   3,   3,   4,   3,   4,   4,   5,   3,   4,   4,   5,   2,   3,   3,   2,
    3,   4,   4,   5,   4,   5,   5,   2,   4,   3,   5,   4,   3,   2,   4,   1,
    3,   4,   4,   5,   4,   5,   3,   4,   4,   5,   5,   2,   3,   4,   2,   1,
    2,   3,   3,   2,   3,   4,   2,   1,   3,   2,   4,   1,   2,   1,   1,   0,
]);

const edge2vertex = new Uint8Array([
	0,1, 1,2, 3,2, 0,3,
	4,5, 5,6, 7,6, 4,7,
	0,4, 1,5, 2,6, 3,7
]);

const cubeVertexPos = new Uint8Array([
	0,0,0, 1,0,0, 1,1,0, 0,1,0,
	0,0,1, 1,0,1, 1,1,1, 0,1,1
]);

const defaultKernelSize = 4096;

// Marching Cubes implementation using GPU.js

export class MarchCubes {
    constructor(field, res_x, res_y, res_z, isoValue = 0) {
        this.res_x = res_x;
        this.res_y = res_y;
        this.res_z = res_z;
        this.isoValue = isoValue;

        this.dx = 1 / (res_x - 1);
        this.dy = 1 / (res_y - 1);
        this.dz = 1 / (res_z - 1);

        this.field = field;
        this.fieldTexture = null;
        this.normTexture = null;
        this.cubeIndexTexture = null;

        this.compileKernels();
        this.cacheFieldData(field);
    }

    compileKernels() {
        if (this.field.nx > defaultKernelSize
            || this.field.ny > defaultKernelSize
            || this.field.nz > defaultKernelSize
            || 3 * this.field.nx * this.field.ny * this.field.nz > defaultKernelSize*defaultKernelSize) {
                console.warn("Field dimensions exceed default GPU texture size limits. Further use may require chunking, which is not implemented.");
        }

        this.send2GPUKernel = gpu.createKernel(function(field) {
            return field[this.thread.z][this.thread.y][this.thread.x];
        })
        .setOutput([this.field.nx, this.field.ny, this.field.nz])
        .setPipeline(true)
        .setImmutable(true); // take responsibility for deleting textures


        this.normCalcKernel = gpu.createKernel(function(field) {
            const x_min = Math.max(this.thread.x - 1, 0);
            const x_max = Math.min(this.thread.x + 1, this.constants.x_limit - 1);
            const y_min = Math.max(this.thread.y - 1, 0);
            const y_max = Math.min(this.thread.y + 1, this.constants.y_limit - 1);
            const z_min = Math.max(this.thread.z - 1, 0);
            const z_max = Math.min(this.thread.z + 1, this.constants.z_limit - 1);
            const norm_x = ( field[this.thread.z][this.thread.y][x_max] - field[this.thread.z][this.thread.y][x_min] ) / (x_max - x_min) / this.constants.dx;
            const norm_y = ( field[this.thread.z][y_max][this.thread.x] - field[this.thread.z][y_min][this.thread.x] ) / (y_max - y_min) / this.constants.dy;
            const norm_z = ( field[z_max][this.thread.y][this.thread.x] - field[z_min][this.thread.y][this.thread.x] ) / (z_max - z_min) / this.constants.dz;
            return [norm_x, norm_y, norm_z];
        })
        .setOutput([this.field.nx, this.field.ny, this.field.nz])
        .setPipeline(true)
        .setImmutable(true)
        .setConstants({
            x_limit: this.field.nx,
            y_limit: this.field.ny,
            z_limit: this.field.nz,
            dx: this.dx,
            dy: this.dy,
            dz: this.dz
        });


        this.countCubeKernel = gpu.createKernel(function(field, isoValue) {
            /* 
            cube_points[0] = vertex_index; 								// v1
            cube_points[1] = vertex_index + x_step; 					// v2
            cube_points[2] = vertex_index + x_step + y_step; 			// v3
            cube_points[3] = vertex_index +        + y_step; 			// v4
            cube_points[4] = vertex_index + 				+ z_step; 	// v5
            cube_points[5] = vertex_index + x_step 			+ z_step; 	// v6
            cube_points[6] = vertex_index + x_step + y_step + z_step; 	// v7
            cube_points[7] = vertex_index 		   + y_step + z_step; 	// v8 
            */
            
            // map the isosurface encapsulation to byte-formatted table index
            // branchless: Math.max(0, Math.sign(iso - val)) = 1 if val < iso, else 0
            let cube_index = 0;
            cube_index += Math.max(0, Math.sign(isoValue - field[this.thread.z][this.thread.y][this.thread.x]));                                // v1
            cube_index += Math.max(0, Math.sign(isoValue - field[this.thread.z][this.thread.y][this.thread.x + 1]))
                            * 2; // v2
            cube_index += Math.max(0, Math.sign(isoValue - field[this.thread.z][this.thread.y + 1][this.thread.x + 1]))
                            * 4; // v3
            cube_index += Math.max(0, Math.sign(isoValue - field[this.thread.z][this.thread.y + 1][this.thread.x]))
                            * 8; // v4
            cube_index += Math.max(0, Math.sign(isoValue - field[this.thread.z + 1][this.thread.y][this.thread.x]))
                            * 16; // v5
            cube_index += Math.max(0, Math.sign(isoValue - field[this.thread.z + 1][this.thread.y][this.thread.x + 1]))
                            * 32; // v6
            cube_index += Math.max(0, Math.sign(isoValue - field[this.thread.z + 1][this.thread.y + 1][this.thread.x + 1]))
                            * 64; // v7
            cube_index += Math.max(0, Math.sign(isoValue - field[this.thread.z + 1][this.thread.y + 1][this.thread.x]))
                            * 128; // v8

            return cube_index;
        }).setOutput([this.field.nx - 1, this.field.ny - 1 , this.field.nz - 1]);

        const triTableInput = input(triTable, [15, 256]);
        const edge2vertexInput = input(edge2vertex, [2, 12]);
        const cubeVertexPosInput = input(cubeVertexPos, [3, 8]);
        this.createVertexKernel = gpu.createKernel(function(field, normalField, cubeInds, cubeFlags, isoValue) {
            const flag = cubeFlags[this.thread.x];
            const edgeToProcess = this.constants.triTable[flag][this.thread.y];

            const vertex1 = this.constants.edge2vertex[edgeToProcess][0];
            const vertex2 = this.constants.edge2vertex[edgeToProcess][1];
            const cubeInd_x = cubeInds[this.thread.x] % this.constants.field_size[0];
            const cubeInd_y = Math.floor(cubeInds[this.thread.x] / this.constants.field_size[0]) % this.constants.field_size[1];
            const cubeInd_z = Math.floor(cubeInds[this.thread.x] / (this.constants.field_size[0] * this.constants.field_size[1]));
            
            const v1_inds = [
                cubeInd_x + this.constants.cubeVertexPos[vertex1][0],
                cubeInd_y + this.constants.cubeVertexPos[vertex1][1],
                cubeInd_z + this.constants.cubeVertexPos[vertex1][2]
            ];
            const v2_inds = [
                cubeInd_x + this.constants.cubeVertexPos[vertex2][0],
                cubeInd_y + this.constants.cubeVertexPos[vertex2][1],
                cubeInd_z + this.constants.cubeVertexPos[vertex2][2]
            ];
            const v1_value = field[v1_inds[2]][v1_inds[1]][v1_inds[0]];
            const v2_value = field[v2_inds[2]][v2_inds[1]][v2_inds[0]];
            const mu = Math.min(1, (isoValue - v1_value) / (v2_value - v1_value));

            if (this.thread.z === 0) {
                const vertex_position = [
                    (v1_inds[0] + mu * (v2_inds[0] - v1_inds[0]))*this.constants.voxel_size[0],
                    (v1_inds[1] + mu * (v2_inds[1] - v1_inds[1]))*this.constants.voxel_size[1],
                    (v1_inds[2] + mu * (v2_inds[2] - v1_inds[2]))*this.constants.voxel_size[2]
                ];
                return vertex_position;
            }
            else {
                const norm1 = normalField[v1_inds[2]][v1_inds[1]][v1_inds[0]];
                const norm2 = normalField[v2_inds[2]][v2_inds[1]][v2_inds[0]];
                
                const vertex_normal = [
                    norm1[0] + mu * (norm2[0] - norm1[0]),
                    norm1[1] + mu * (norm2[1] - norm1[1]),
                    norm1[2] + mu * (norm2[2] - norm1[2])
                ];
                return vertex_normal;
            }
            
        })
        .setDynamicOutput(true)
        .setDynamicArguments(true)
        .setConstants({triTable: triTableInput,
            edge2vertex: edge2vertexInput,
            cubeVertexPos: cubeVertexPosInput,
            voxel_size: [this.dx, this.dy, this.dz],
            field_size: [this.field.nx, this.field.ny, this.field.nz],
            ind_loop: 3
        });
    }

    clearCache() {
        if (this.fieldTexture) {
            this.fieldTexture.delete();
        }
        if (this.normTexture) {
            this.normTexture.delete();
        }
    }

    cacheFieldData() {
        if (this.fieldTexture) {
            this.clearCache();
        }
        const fieldInput = input(this.field.values, [this.field.nx, this.field.ny, this.field.nz]);
        this.fieldTexture = this.send2GPUKernel(fieldInput);
        this.normTexture = this.normCalcKernel(this.fieldTexture);
    }

    getVerticesForIso(isoValue) {
        const cubeFlags = this.countCubeKernel(this.fieldTexture, isoValue);

        let partitionedCubeFlags = [[],[],[],[],[]];
        let partitionedCubeInds = [[],[],[],[],[]];
        let partitionedVertexInds = [[],[],[],[],[]];
        let ind = 0;
        for (let z = 0; z < this.field.nz - 1; z++) {
            for (let y = 0; y < this.field.ny - 1; y++) {
                for (let x = 0; x < this.field.nx - 1; x++) {
                    const flag = cubeFlags[z][y][x];
                    const numTris = triTableCount[flag];
                    if (numTris > 0) {
                        partitionedVertexInds[numTris-1].push(ind);
                        partitionedCubeFlags[numTris-1].push(flag);
                        partitionedCubeInds[numTris-1].push(x + y * this.field.nx + z * this.field.nx * this.field.ny);
                        ind += numTris*3*3;
                    }
                }
            }
        }

        let totalVertices = 0;
        for (let i = 0; i < 5; i++) {
            totalVertices += partitionedCubeFlags[i].length * 3 * (i+1); // 3 vertices per triangle
        }
        let vertices = new Float32Array(totalVertices * 3);
        let normals = new Float32Array(totalVertices * 3);

        // determine max texture size and check if chunking is needed
        const gl = gpu.context;
        const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        const maxTexels = maxTextureSize * maxTextureSize;

        // field/norm textures: nx * ny * nz texels (3-component for normals)
        const fieldTexels = this.field.nx * this.field.ny * this.field.nz;
        if (fieldTexels > maxTexels) {
            console.warn(`Field texture (${fieldTexels} texels) exceeds GPU max (${maxTexels}). Chunking required but not implemented.`);
        }

        let c = 0;
        for (let i = 0; i < 5; i++) {
            if (partitionedCubeFlags[i].length === 0) {
                continue;
            }
            const numEdges = 3*(i+1); // 3 vertices per triangle
            this.createVertexKernel.setOutput([partitionedCubeInds[i].length, numEdges, 2]);
            const ind_inputs = input(partitionedCubeInds[i], [partitionedCubeInds[i].length]);
            const flag_inputs = input(partitionedCubeFlags[i], [partitionedCubeFlags[i].length]);
            const data = this.createVertexKernel(this.fieldTexture, this.normTexture, ind_inputs, flag_inputs, isoValue);
            for (let j = 0; j < data[0][0].length; j++) {
                for (let k = 0; k < numEdges; k++) {
                    vertices.set(data[0][k][j], partitionedVertexInds[i][j] + 3*k);
                    normals.set(data[1][k][j], partitionedVertexInds[i][j] + 3*k);
                }
            }
        }
        return {vertices, normals};
    }

    delete() {
        this.clearCache();
    }
}