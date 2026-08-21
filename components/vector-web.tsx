"use client";

/* eslint-disable react-hooks/immutability --
   Three.js materials and buffers are mutated in useFrame by design. */
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { buildConstellation, type WebEdge } from "@/lib/constellation";
import { nearestK, type GridIndex } from "@/lib/spatial";
import { isClusterVisible, useVectorStore } from "@/lib/store";

const VERTEX = /* glsl */ `
attribute float aIndex;
attribute float aSize;
attribute float aVisible;
uniform float uBaseSize;
uniform float uPerspScale;
uniform float uOrthoZoom;
uniform float uIsOrtho;
uniform float uPixelRatio;
uniform float uPicking;
varying vec3 vColor;
varying float vIndex;
varying float vVisible;
void main() {
  vIndex = aIndex;
  vColor = color;
  vVisible = aVisible;
  if (aVisible < 0.5) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float px = uIsOrtho > 0.5
    ? uBaseSize * uOrthoZoom
    : uBaseSize * uPerspScale / max(0.0001, -mv.z);
  px *= max(0.45, aSize);
  if (uPicking > 0.5) px *= 2.4;
  gl_PointSize = px * uPixelRatio;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT = /* glsl */ `
uniform float uPicking;
varying vec3 vColor;
varying float vIndex;
varying float vVisible;
void main() {
  if (vVisible < 0.5) discard;
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float d = length(uv);
  if (uPicking > 0.5) {
    if (d > 0.92) discard;
    float idx = vIndex + 1.0;
    float r = mod(idx, 256.0);
    float g = mod(floor(idx / 256.0), 256.0);
    float b = floor(idx / 65536.0);
    gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
    return;
  }
  if (d > 1.0) discard;
  float core = exp(-d * d * 22.0);
  float bloom = exp(-d * 7.5) * 0.45;
  float halo = exp(-d * 2.2) * 0.28;
  float alpha = clamp(core + bloom + halo, 0.0, 1.0);
  vec3 col = vColor * (0.42 + 2.1 * core + 0.55 * bloom);
  gl_FragColor = vec4(col, alpha);
}
`;

export function makePointsMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    uniforms: {
      uBaseSize: { value: 1 },
      uPerspScale: { value: 500 },
      uOrthoZoom: { value: 1 },
      uIsOrtho: { value: 1 },
      uPixelRatio: { value: 1 },
      uPicking: { value: 0 },
    },
  });
}

export function setPicking(material: THREE.ShaderMaterial, on: boolean) {
  material.uniforms.uPicking.value = on ? 1 : 0;
  material.blending = on ? THREE.NoBlending : THREE.AdditiveBlending;
  material.transparent = !on;
  material.depthTest = on;
  material.depthWrite = on;
}

export function makePointsGeometry(
  positions: Float32Array,
  colorsRgb: Uint8Array,
  count: number,
  sizes?: Float32Array,
) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colorsRgb, 3, true));
  const index = new Float32Array(count);
  for (let i = 0; i < count; i++) index[i] = i;
  geometry.setAttribute("aIndex", new THREE.BufferAttribute(index, 1));
  geometry.setAttribute(
    "aSize",
    new THREE.BufferAttribute(sizes ?? new Float32Array(count).fill(1), 1),
  );
  geometry.setAttribute(
    "aVisible",
    new THREE.BufferAttribute(new Float32Array(count).fill(1), 1),
  );
  geometry.computeBoundingSphere();
  return geometry;
}

export function syncPointUniforms(
  material: THREE.ShaderMaterial,
  gl: THREE.WebGLRenderer,
  camera: THREE.Camera,
  sizeHeight: number,
  baseSize: number,
) {
  const u = material.uniforms;
  u.uPixelRatio.value = gl.getPixelRatio();
  u.uBaseSize.value = baseSize;
  const isOrtho = (camera as THREE.OrthographicCamera).isOrthographicCamera;
  u.uIsOrtho.value = isOrtho ? 1 : 0;
  if (isOrtho) {
    u.uOrthoZoom.value = (camera as THREE.OrthographicCamera).zoom;
  } else {
    const persp = camera as THREE.PerspectiveCamera;
    u.uPerspScale.value =
      sizeHeight / (2 * Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2));
  }
}

function makeEdgeGeometry(
  positions: Float32Array,
  colors: Uint8Array,
  edges: WebEdge[],
  maxDist: number,
) {
  const positionsOut = new Float32Array(edges.length * 6);
  const colorsOut = new Float32Array(edges.length * 6);
  for (let e = 0; e < edges.length; e++) {
    const { i, j, dist } = edges[e];
    const fade = 1 - dist / Math.max(maxDist, 1e-9);
    const alpha = 0.18 + fade * 0.55;
    positionsOut[e * 6] = positions[i * 3];
    positionsOut[e * 6 + 1] = positions[i * 3 + 1];
    positionsOut[e * 6 + 2] = positions[i * 3 + 2];
    positionsOut[e * 6 + 3] = positions[j * 3];
    positionsOut[e * 6 + 4] = positions[j * 3 + 1];
    positionsOut[e * 6 + 5] = positions[j * 3 + 2];
    for (let c = 0; c < 3; c++) {
      const ca = (colors[i * 4 + c] / 255) * alpha;
      const cb = (colors[j * 4 + c] / 255) * alpha;
      colorsOut[e * 6 + c] = ca;
      colorsOut[e * 6 + 3 + c] = cb;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positionsOut, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colorsOut, 3));
  return geometry;
}

function makeArcGeometry(
  origin: [number, number, number],
  targets: { position: [number, number, number]; dist: number }[],
  from: THREE.Color,
  to: THREE.Color,
) {
  const SEGMENTS = 14;
  const positions = new Float32Array(targets.length * SEGMENTS * 2 * 3);
  const colors = new Float32Array(targets.length * SEGMENTS * 2 * 3);
  const maxD = Math.max(...targets.map((t) => t.dist), 1e-9);
  const a = new THREE.Vector3(...origin);
  let ptr = 0;
  for (const t of targets) {
    const b = new THREE.Vector3(...t.position);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.z += a.distanceTo(b) * 0.28;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const strength = 1 - t.dist / maxD;
    const edge = from.clone().lerp(to, 1 - strength);
    let prev = curve.getPoint(0);
    for (let i = 1; i <= SEGMENTS; i++) {
      const p = curve.getPoint(i / SEGMENTS);
      positions[ptr * 3] = prev.x;
      positions[ptr * 3 + 1] = prev.y;
      positions[ptr * 3 + 2] = prev.z;
      colors[ptr * 3] = from.r;
      colors[ptr * 3 + 1] = from.g;
      colors[ptr * 3 + 2] = from.b;
      ptr++;
      positions[ptr * 3] = p.x;
      positions[ptr * 3 + 1] = p.y;
      positions[ptr * 3 + 2] = p.z;
      colors[ptr * 3] = edge.r;
      colors[ptr * 3 + 1] = edge.g;
      colors[ptr * 3 + 2] = edge.b;
      ptr++;
      prev = p;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function LineWeb({
  geometry,
  opacity,
}: {
  geometry: THREE.BufferGeometry | null;
  opacity: number;
}) {
  if (!geometry) return null;
  return (
    <lineSegments geometry={geometry} frustumCulled={false}>
      <lineBasicMaterial
        vertexColors
        transparent
        opacity={opacity}
        blending={THREE.AdditiveBlending}
        depthTest={false}
        depthWrite={false}
      />
    </lineSegments>
  );
}

export function BackgroundWeb({
  positions,
  colors,
  count,
  extent,
}: {
  positions: Float32Array;
  colors: Uint8Array;
  count: number;
  extent: number;
}) {
  const clusters = useVectorStore((s) => s.cloud?.clusters);
  const selectedClusters = useVectorStore((s) => s.selectedClusters);

  const built = useMemo(() => {
    if (count < 2 || extent <= 0) return null;
    return buildConstellation(positions, count, extent);
  }, [positions, count, extent]);

  const geometry = useMemo(() => {
    if (!built) return null;
    const edges =
      selectedClusters === null || !clusters
        ? built.edges
        : built.edges.filter(
            (e) =>
              isClusterVisible(selectedClusters, clusters[e.i]) &&
              isClusterVisible(selectedClusters, clusters[e.j]),
          );
    return makeEdgeGeometry(positions, colors, edges, built.maxDist);
  }, [built, positions, colors, clusters, selectedClusters]);

  useEffect(() => () => geometry?.dispose(), [geometry]);

  return <LineWeb geometry={geometry} opacity={0.55} />;
}

export function HoverWeb({
  index,
  baseSize,
  extent,
}: {
  index: GridIndex | null;
  baseSize: number;
  extent: number;
}) {
  const hoverIndex = useVectorStore((s) => s.hoverIndex);
  const cloud = useVectorStore((s) => s.cloud);
  const selectedClusters = useVectorStore((s) => s.selectedClusters);
  const material = useMemo(() => makePointsMaterial(), []);
  const pulseRef = useRef<THREE.Mesh>(null);

  const local = useMemo(() => {
    if (!index || !cloud || hoverIndex === null) return null;
    if (!isClusterVisible(selectedClusters, cloud.clusters[hoverIndex])) return null;
    const x = cloud.positions[hoverIndex * 3];
    const y = cloud.positions[hoverIndex * 3 + 1];
    const z = cloud.positions[hoverIndex * 3 + 2];
    const nbrs = nearestK(index, x, y, z, 14, extent * 0.12).filter(
      (n) =>
        n.idx !== hoverIndex &&
        isClusterVisible(selectedClusters, cloud.clusters[n.idx]),
    );
    if (nbrs.length === 0) return { origin: [x, y, z] as [number, number, number], nbrs, arcs: null, nodes: null };
    const arcs = makeArcGeometry(
      [x, y, z],
      nbrs.map((n) => ({
        position: [
          cloud.positions[n.idx * 3],
          cloud.positions[n.idx * 3 + 1],
          cloud.positions[n.idx * 3 + 2],
        ],
        dist: n.dist,
      })),
      new THREE.Color(0x7dd3fc),
      new THREE.Color(0xa78bfa),
    );
    const nodePos = new Float32Array((nbrs.length + 1) * 3);
    const nodeCol = new Uint8Array((nbrs.length + 1) * 3);
    nodePos[0] = x;
    nodePos[1] = y;
    nodePos[2] = z;
    nodeCol[0] = 224;
    nodeCol[1] = 242;
    nodeCol[2] = 254;
    for (let i = 0; i < nbrs.length; i++) {
      nodePos[(i + 1) * 3] = cloud.positions[nbrs[i].idx * 3];
      nodePos[(i + 1) * 3 + 1] = cloud.positions[nbrs[i].idx * 3 + 1];
      nodePos[(i + 1) * 3 + 2] = cloud.positions[nbrs[i].idx * 3 + 2];
      nodeCol[(i + 1) * 3] = 167;
      nodeCol[(i + 1) * 3 + 1] = 139;
      nodeCol[(i + 1) * 3 + 2] = 250;
    }
    return {
      origin: [x, y, z] as [number, number, number],
      nbrs,
      arcs,
      nodes: makePointsGeometry(nodePos, nodeCol, nbrs.length + 1),
    };
  }, [index, cloud, hoverIndex, extent, selectedClusters]);

  useFrame(({ gl, camera, size, clock }) => {
    syncPointUniforms(material, gl, camera, size.height, baseSize * 2.1);
    if (!pulseRef.current) return;
    pulseRef.current.quaternion.copy(camera.quaternion);
    const s = 1 + 0.16 * Math.sin(clock.elapsedTime * 3.2);
    pulseRef.current.scale.setScalar(s);
  });

  useEffect(
    () => () => {
      local?.arcs?.dispose();
      local?.nodes?.dispose();
    },
    [local],
  );

  if (!local) return null;

  return (
    <group>
      <LineWeb geometry={local.arcs} opacity={0.95} />
      {local.nodes && (
        <points geometry={local.nodes} material={material} frustumCulled={false} />
      )}
      <mesh ref={pulseRef} position={local.origin}>
        <ringGeometry args={[baseSize * 2.2, baseSize * 2.7, 64]} />
        <meshBasicMaterial
          color={0x7dd3fc}
          transparent
          opacity={0.75}
          side={THREE.DoubleSide}
          depthTest={false}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  );
}

export function SelectionWeb({
  baseSize,
}: {
  baseSize: number;
}) {
  const selectedId = useVectorStore((s) => s.selectedId);
  const selectedPoint = useVectorStore((s) => s.selectedPoint);
  const neighbors = useVectorStore((s) => s.neighbors);
  const cloud = useVectorStore((s) => s.cloud);
  const storedPos = useVectorStore((s) => s.selectedPos);

  const selectedPos = useMemo((): [number, number, number] | null => {
    if (storedPos) return storedPos;
    if (
      selectedPoint &&
      typeof selectedPoint.x === "number" &&
      typeof selectedPoint.y === "number"
    ) {
      return [selectedPoint.x, selectedPoint.y, (selectedPoint.z as number) ?? 0];
    }
    return null;
  }, [storedPos, selectedPoint]);

  const ringRef = useRef<THREE.Mesh>(null);
  useFrame(({ camera, clock }) => {
    if (!ringRef.current) return;
    ringRef.current.quaternion.copy(camera.quaternion);
    const s = 1 + 0.12 * Math.sin(clock.elapsedTime * 3);
    ringRef.current.scale.setScalar(s);
  });

  const nbrs = useMemo(
    () =>
      neighbors
        .filter((n) => typeof n.x === "number" && typeof n.y === "number")
        .map((n) => ({
          position: [n.x as number, n.y as number, (n.z as number) ?? 0] as [
            number,
            number,
            number,
          ],
          dist: typeof n.distance === "number" ? n.distance : 1,
        })),
    [neighbors],
  );

  const arcs = useMemo(() => {
    if (!selectedPos || nbrs.length === 0) return null;
    return makeArcGeometry(selectedPos, nbrs, new THREE.Color(0x7dd3fc), new THREE.Color(0xfbbf24));
  }, [selectedPos, nbrs]);

  const neighborGeometry = useMemo(() => {
    if (nbrs.length === 0) return null;
    const positions = new Float32Array(nbrs.length * 3);
    const colors = new Uint8Array(nbrs.length * 3);
    for (let i = 0; i < nbrs.length; i++) {
      positions[i * 3] = nbrs[i].position[0];
      positions[i * 3 + 1] = nbrs[i].position[1];
      positions[i * 3 + 2] = nbrs[i].position[2];
      colors[i * 3] = 251;
      colors[i * 3 + 1] = 191;
      colors[i * 3 + 2] = 36;
    }
    return makePointsGeometry(positions, colors, nbrs.length);
  }, [nbrs]);

  const selectedGeometry = useMemo(() => {
    if (!selectedPos) return null;
    return makePointsGeometry(
      new Float32Array(selectedPos),
      new Uint8Array([255, 255, 255]),
      1,
    );
  }, [selectedPos]);

  const neighborMaterial = useMemo(() => makePointsMaterial(), []);
  const selectedMaterial = useMemo(() => makePointsMaterial(), []);

  useFrame(({ gl, camera, size }) => {
    syncPointUniforms(neighborMaterial, gl, camera, size.height, baseSize * 2.2);
    syncPointUniforms(selectedMaterial, gl, camera, size.height, baseSize * 2.8);
  });

  useEffect(
    () => () => {
      arcs?.dispose();
      neighborGeometry?.dispose();
      selectedGeometry?.dispose();
    },
    [arcs, neighborGeometry, selectedGeometry],
  );

  if (selectedId === null || !selectedPos || !cloud) return null;

  return (
    <group>
      <LineWeb geometry={arcs} opacity={0.9} />
      {neighborGeometry && (
        <points geometry={neighborGeometry} material={neighborMaterial} frustumCulled={false} />
      )}
      {selectedGeometry && (
        <points geometry={selectedGeometry} material={selectedMaterial} frustumCulled={false} />
      )}
      <mesh ref={ringRef} position={selectedPos}>
        <ringGeometry args={[baseSize * 3.1, baseSize * 3.6, 64]} />
        <meshBasicMaterial
          color={0xfbbf24}
          transparent
          opacity={0.85}
          side={THREE.DoubleSide}
          depthTest={false}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
    </group>
  );
}
