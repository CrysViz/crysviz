export {
  transpose3x3,
  invert3x3,
  matVec,
  fracToCart,
  normalizeFractional,
  normalizeFractionalPoint,
  normalizeFractionalPositions,
} from '../math/index.js';

import { cartToFrac as cartToFractional } from '../math/index.js';

export function cartToFrac(cart, lattice) {
  return cart.map((point) => cartToFractional(point, lattice));
}
