import { ColoredObject } from './ColoredObject.js';

export class Polyhedron extends ColoredObject {
  /**
   * A single coordination polyhedron, stored as plain data (no three.js) so it
   * can live on a Structure. The renderer rebuilds the convex hull from
   * `vertices` and reads the remaining fields for styling / picking.
   *
   * @param {Object} [opts]
   * @param {string} [opts.name]
   * @param {number[][]} [opts.vertices]      Cartesian vertex positions [[x,y,z], ...]
   * @param {number|null} [opts.centerIndex]  source atom index of the center ('centered'), else null
   * @param {'centered'|'cage'|null} [opts.type]
   * @param {string|null} [opts.centerElement] element symbol of the center atom ('centered' only)
   * @param {string|null} [opts.colorElem]    element symbol used to color the polyhedron
   * @param {number[]} [opts.vertexSrcList]   source atom index per vertex
   * @param {number[][]} [opts.reserveVertices] corners not in use now but kept
   *   for return during playback (bond breaking tolerance,
   *   render/PolyhedraFrameModule.js): their bond to the centre is broken;
   *   one that comes back within the cutoff becomes a vertex again
   * @param {number[]} [opts.reserveSrcList]    source atom index per reserved corner
   */
  constructor({
    name = "",
    vertices = [],
    centerIndex = null,
    type = null,
    centerElement = null,
    colorElem = null,
    vertexSrcList = [],
    reserveVertices = [],
    reserveSrcList = [],
  } = {}) {
    super();
    this.name = name;
    this.vertices = vertices;
    this.centerIndex = centerIndex;
    this.type = type;
    this.centerElement = centerElement;
    this.colorElem = colorElem;
    this.vertexSrcList = vertexSrcList;
    this.reserveVertices = reserveVertices;
    this.reserveSrcList = reserveSrcList;
  }

  get numVertices() {
    return this.vertices.length;
  }
}

