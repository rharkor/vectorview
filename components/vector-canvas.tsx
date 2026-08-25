"use client";

/* eslint-disable react-hooks/immutability --
   Three.js objects (materials, cameras, controls) are mutable by design;
   updating uniforms and camera state in useFrame/effects is the R3F idiom. */
import {
  MapControls,
  OrbitControls,
  OrthographicCamera,
  PerspectiveCamera,
} from "@react-three/drei";
import type { RootState } from "@react-three/fiber";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { tableFromIPC } from "apache-arrow";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

import {
  BackgroundWeb,
  HoverWeb,
  makePointsGeometry,
  makePointsMaterial,
  SelectionWeb,
  setPicking,
  syncPointUniforms,
} from "@/components/vector-web";
import { buildClusterColors, clusterColor } from "@/lib/colors";
import { buildGrid, type GridIndex, queryRadius } from "@/lib/spatial";
import { isClusterVisible, useVectorStore } from "@/lib/store";

type OrbitControlsImpl = React.ComponentRef<typeof OrbitControls>;

const CANVAS_DPR: [number, number] = [1, 2];
const CANVAS_GL = { antialias: true, alpha: true };
const NDC = new THREE.Vector3();
const WORLD = new THREE.Vector3();
const PROJECTED = new THREE.Vector3();
const FLY_POS = new THREE.Vector3();

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function UniformSync({
  material,
  baseSize,
  cameraRef,
}: {
  material: THREE.ShaderMaterial;
  baseSize: number;
  cameraRef: React.RefObject<THREE.Camera | null>;
}) {
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  useFrame(() => {
    const camera = cameraRef.current;
    if (!camera) return;
    syncPointUniforms(material, gl, camera, size.height, baseSize);
  });
  return null;
}

function CameraRig({
  viewMode,
  extent,
  center,
  controlsRef,
  cameraRef,
}: {
  viewMode: "2d" | "3d";
  extent: number;
  center: [number, number, number];
  controlsRef: React.RefObject<OrbitControlsImpl | null>;
  cameraRef: React.RefObject<THREE.Camera | null>;
}) {
  const flyTarget = useVectorStore((s) => s.flyTarget);
  const set = useThree((s) => s.set);
  const get = useThree((s) => s.get);
  const fly = useRef<{ target: THREE.Vector3; extent?: number } | null>(null);
  const cx = center[0];
  const cy = center[1];
  const cz = center[2];

  // biome-ignore lint/correctness/useExhaustiveDependencies: rebind camera when switching 2D/3D
  useEffect(() => {
    if (cameraRef.current) {
      set({ camera: cameraRef.current as never });
    }
  }, [viewMode, cameraRef, set]);

  useEffect(() => {
    if (extent <= 0 || !Number.isFinite(extent)) return;
    let cancelled = false;
    const apply = () => {
      if (cancelled) return;
      const controls = controlsRef.current;
      const cam = cameraRef.current;
      if (!controls || !cam) {
        requestAnimationFrame(apply);
        return;
      }
      const { width, height } = get().size;
      controls.target.set(cx, cy, cz);
      if (viewMode === "2d") {
        const ortho = cam as THREE.OrthographicCamera;
        ortho.zoom = Math.min(width / extent, height / extent) * 0.85;
        ortho.position.set(cx, cy, 100);
        ortho.updateProjectionMatrix();
      } else {
        const persp = cam as THREE.PerspectiveCamera;
        const dist = (extent / 2 / Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2)) * 1.3;
        persp.position.set(cx, cy - dist * 0.4, cz + dist);
      }
      controls.update();
    };
    apply();
    return () => {
      cancelled = true;
    };
  }, [extent, cx, cy, cz, viewMode, controlsRef, cameraRef, get]);

  useEffect(() => {
    if (flyTarget) {
      fly.current = {
        target: new THREE.Vector3(flyTarget.x, flyTarget.y, flyTarget.z),
        extent: flyTarget.extent,
      };
    }
  }, [flyTarget]);

  useFrame(() => {
    const controls = controlsRef.current;
    const cam = cameraRef.current;
    if (!controls || !cam || !fly.current) return;
    const dest = fly.current.target;
    controls.target.lerp(dest, 0.12);
    if (fly.current.extent && fly.current.extent > 0) {
      const { width, height } = get().size;
      const ext = fly.current.extent;
      if ((cam as THREE.OrthographicCamera).isOrthographicCamera) {
        const ortho = cam as THREE.OrthographicCamera;
        const targetZoom = Math.min(width / ext, height / ext) * 0.85;
        ortho.zoom += (targetZoom - ortho.zoom) * 0.12;
        ortho.position.set(controls.target.x, controls.target.y, 100);
        ortho.updateProjectionMatrix();
      } else {
        const persp = cam as THREE.PerspectiveCamera;
        const dist = (ext / 2 / Math.tan(THREE.MathUtils.degToRad(persp.fov) / 2)) * 1.3;
        FLY_POS.set(dest.x, dest.y - dist * 0.4, dest.z + dist);
        persp.position.lerp(FLY_POS, 0.12);
      }
    }
    if (controls.target.distanceTo(dest) < Math.max(extent * 0.0005, 1e-5)) {
      controls.target.copy(dest);
      fly.current = null;
    }
    controls.update();
  });

  return null;
}

function unprojectCursor(
  camera: THREE.Camera,
  size: { width: number; height: number },
  cssX: number,
  cssY: number,
) {
  NDC.set((cssX / size.width) * 2 - 1, -(cssY / size.height) * 2 + 1, 0);
  WORLD.copy(NDC).unproject(camera);
  return WORLD;
}

function screenDistance(
  camera: THREE.Camera,
  size: { width: number; height: number },
  cssX: number,
  cssY: number,
  x: number,
  y: number,
  z: number,
) {
  PROJECTED.set(x, y, z).project(camera);
  const sx = (PROJECTED.x * 0.5 + 0.5) * size.width;
  const sy = (-PROJECTED.y * 0.5 + 0.5) * size.height;
  return Math.hypot(sx - cssX, sy - cssY);
}

function pickRadius(camera: THREE.Camera, extent: number, baseSize: number) {
  const ortho = camera as THREE.OrthographicCamera;
  if (ortho.isOrthographicCamera) {
    return Math.max(baseSize * 2.8, 16 / Math.max(ortho.zoom, 1e-6));
  }
  return Math.max(baseSize * 3.2, extent * 0.014);
}

function pointLabel(labels: string[], ids: string[], idx: number) {
  return labels[idx] || `id: ${ids[idx]}`;
}

function fillTooltip(
  el: HTMLDivElement,
  x: number,
  y: number,
  rows: { title: string; hint?: string }[],
) {
  el.replaceChildren();
  const primary = rows[0];
  if (!primary) {
    el.style.display = "none";
    return;
  }
  const title = document.createElement("div");
  title.className = "truncate text-xs text-sky-100";
  title.textContent = primary.title;
  el.appendChild(title);
  if (primary.hint) {
    const hint = document.createElement("div");
    hint.className = "truncate font-mono text-[10px] text-white/40";
    hint.textContent = primary.hint;
    el.appendChild(hint);
  }
  if (rows.length > 1) {
    const banner = document.createElement("div");
    banner.className =
      "mt-1.5 border-t border-white/10 pt-1.5 text-[10px] uppercase tracking-wide text-amber-200/80";
    banner.textContent = `${rows.length} overlapping`;
    el.appendChild(banner);
    for (const row of rows.slice(1, 5)) {
      const line = document.createElement("div");
      line.className = "truncate text-[11px] text-white/70";
      line.textContent = row.title;
      el.appendChild(line);
    }
    if (rows.length > 5) {
      const rest = document.createElement("div");
      rest.className = "text-[10px] text-white/40";
      rest.textContent = `+${rows.length - 5} more`;
      el.appendChild(rest);
    }
  }
  el.style.display = "block";
  el.style.left = `${x + 14}px`;
  el.style.top = `${y + 10}px`;
}

export function VectorCanvas() {
  const cloud = useVectorStore((s) => s.cloud);
  const viewMode = useVectorStore((s) => s.viewMode);
  const pointSize = useVectorStore((s) => s.pointSize);
  const sample = useVectorStore((s) => s.sample);
  const dataVersion = useVectorStore((s) => s.dataVersion);

  const setCloud = useVectorStore((s) => s.setCloud);
  const setLoading = useVectorStore((s) => s.setLoading);
  const setError = useVectorStore((s) => s.setError);
  const selectPoint = useVectorStore((s) => s.selectPoint);
  const setHoverIndex = useVectorStore((s) => s.setHoverIndex);
  const setFps = useVectorStore((s) => s.setFps);

  const [extent, setExtent] = useState(0);
  const [center, setCenter] = useState<[number, number, number]>([0, 0, 0]);
  const hoverEl = useRef<HTMLDivElement>(null);

  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const cameraRef = useRef<THREE.Camera | null>(null);
  const overlaysRef = useRef<THREE.Group | null>(null);
  const pointMaterial = useMemo(() => makePointsMaterial(), []);
  const pickFbo = useMemo(() => new THREE.WebGLRenderTarget(1, 1), []);
  const renderTimes = useRef<number[]>([]);
  const downPos = useRef<[number, number] | null>(null);
  const glRef = useRef<RootState | null>(null);
  const hoverRaf = useRef(0);

  const baseSize = Math.max(extent / 360, 1e-6) * pointSize;

  const index = useMemo<GridIndex | null>(() => {
    if (!cloud || extent <= 0) return null;
    return buildGrid(cloud.positions, cloud.count, extent / 72);
  }, [cloud, extent]);

  useEffect(() => {
    const interval = setInterval(() => {
      const cutoff = performance.now() - 1000;
      renderTimes.current = renderTimes.current.filter((t) => t >= cutoff);
      setFps(renderTimes.current.length);
    }, 500);
    return () => clearInterval(interval);
  }, [setFps]);

  const load = useCallback(
    async (sampleRate: number) => {
      setLoading(true, 0);
      try {
        const res = await fetch(`/api/points?sample=${sampleRate}`);
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(body?.error ?? `Failed to load points (HTTP ${res.status})`);
          return;
        }
        const total = Number(res.headers.get("X-Total-Count") ?? "0");
        const contentLength = Number(res.headers.get("Content-Length") ?? "0");
        const reader = res.body!.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (contentLength > 0) setLoading(true, received / contentLength);
        }

        const table = tableFromIPC(concatChunks(chunks, received));
        const ids = Array.from(table.getChild("id")!.toArray() as ArrayLike<string>, String);
        const labels = Array.from(table.getChild("label")!.toArray() as ArrayLike<string>, String);
        const xs = table.getChild("x")!.toArray() as Float32Array;
        const ys = table.getChild("y")!.toArray() as Float32Array;
        const zs = table.getChild("z")!.toArray() as Float32Array;
        const clusters = table.getChild("cluster")!.toArray() as Int32Array;

        const n = ids.length;
        const positions = new Float32Array(n * 3);
        const colors = new Uint8Array(n * 4);
        const clusterColors = buildClusterColors(clusters, n);

        let minX = Infinity,
          maxX = -Infinity,
          minY = Infinity,
          maxY = -Infinity;
        for (let i = 0; i < n; i++) {
          const x = xs[i],
            y = ys[i],
            z = zs[i];
          positions[i * 3] = x;
          positions[i * 3 + 1] = y;
          positions[i * 3 + 2] = z;
          const [r, g, b] = clusterColor(clusters[i], clusterColors);
          colors[i * 4] = r;
          colors[i * 4 + 1] = g;
          colors[i * 4 + 2] = b;
          colors[i * 4 + 3] = 235;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }

        setCloud(
          {
            ids,
            labels,
            positions,
            colors,
            clusters: Int32Array.from(clusters),
            clusterColors,
            count: n,
          },
          total,
          n,
        );

        if (n > 0) {
          const extentX = Math.max(maxX - minX, 1e-6);
          const extentY = Math.max(maxY - minY, 1e-6);
          const nextCx = (minX + maxX) / 2;
          const nextCy = (minY + maxY) / 2;
          if (Number.isFinite(nextCx) && Number.isFinite(nextCy)) {
            setExtent(Math.max(extentX, extentY));
            setCenter([nextCx, nextCy, 0]);
          }
        }
      } catch (error) {
        setError(error instanceof Error ? error.message : "Failed to load points");
      }
    },
    [setCloud, setError, setLoading],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload after import/remap
  useEffect(() => {
    const handle = setTimeout(() => load(sample), sample === 1 ? 0 : 400);
    return () => clearTimeout(handle);
  }, [load, sample, dataVersion]);

  const geometry = useMemo(() => {
    if (!cloud) return null;
    const rgb = new Uint8Array(cloud.count * 3);
    const sizes = new Float32Array(cloud.count);
    for (let i = 0; i < cloud.count; i++) {
      rgb[i * 3] = cloud.colors[i * 4];
      rgb[i * 3 + 1] = cloud.colors[i * 4 + 1];
      rgb[i * 3 + 2] = cloud.colors[i * 4 + 2];
      const t = ((i * 1103515245 + 12345) >>> 0) / 4294967295;
      sizes[i] = 0.62 + t * 0.85;
    }
    return makePointsGeometry(cloud.positions, rgb, cloud.count, sizes);
  }, [cloud]);

  useEffect(() => () => geometry?.dispose(), [geometry]);

  const hiddenClusters = useVectorStore((s) => s.hiddenClusters);
  const focusedCluster = useVectorStore((s) => s.focusedCluster);
  const highlightedIds = useVectorStore((s) => s.highlightedIds);
  useEffect(() => {
    if (!geometry || !cloud) return;
    const visible = geometry.getAttribute("aVisible") as THREE.BufferAttribute | undefined;
    if (!visible) return;
    for (let i = 0; i < cloud.count; i++) {
      visible.setX(i, isClusterVisible(hiddenClusters, cloud.clusters[i]) ? 1 : 0);
    }
    visible.needsUpdate = true;
  }, [geometry, cloud, hiddenClusters]);

  useEffect(() => {
    if (!geometry || !cloud) return;
    const highlight = geometry.getAttribute("aHighlight") as THREE.BufferAttribute | undefined;
    if (!highlight) return;
    const hasSearch = highlightedIds.size > 0;
    for (let i = 0; i < cloud.count; i++) {
      let value = 1;
      if (focusedCluster !== null) {
        value = cloud.clusters[i] === focusedCluster ? 1 : 0;
      } else if (hasSearch) {
        value = highlightedIds.has(cloud.ids[i]) ? 1 : 0;
      }
      highlight.setX(i, value);
    }
    highlight.needsUpdate = true;
  }, [geometry, cloud, focusedCluster, highlightedIds]);

  const gpuPick = useCallback(
    (state: RootState, cssX: number, cssY: number): number => {
      if (!cloud || !geometry) return -1;
      const { gl, scene, size } = state;
      const camera = cameraRef.current ?? state.camera;
      const dpr = gl.getPixelRatio();
      const w = Math.max(1, Math.floor(size.width * dpr));
      const h = Math.max(1, Math.floor(size.height * dpr));
      pickFbo.setSize(w, h);

      const prevTarget = gl.getRenderTarget();
      const prevClearColor = new THREE.Color();
      gl.getClearColor(prevClearColor);
      const prevClearAlpha = gl.getClearAlpha();
      if (overlaysRef.current) overlaysRef.current.visible = false;
      setPicking(pointMaterial, true);
      gl.setRenderTarget(pickFbo);
      gl.setClearColor(0x000000, 0);
      gl.clear(true, true, true);
      gl.render(scene, camera);

      const px = new Uint8Array(4);
      gl.readRenderTargetPixels(
        pickFbo,
        Math.floor(cssX * dpr),
        Math.max(0, h - Math.floor(cssY * dpr) - 1),
        1,
        1,
        px,
      );

      setPicking(pointMaterial, false);
      if (overlaysRef.current) overlaysRef.current.visible = true;
      gl.setClearColor(prevClearColor, prevClearAlpha);
      gl.setRenderTarget(prevTarget);
      if (px[3] < 128) return -1;
      const idx = px[0] + px[1] * 256 + px[2] * 65536 - 1;
      return idx >= 0 && idx < cloud.count ? idx : -1;
    },
    [cloud, geometry, pickFbo, pointMaterial],
  );

  const resolveHits = useCallback(
    (state: RootState, cssX: number, cssY: number): number[] => {
      if (!cloud) return [];
      const camera = cameraRef.current ?? state.camera;
      const radius = pickRadius(camera, extent, baseSize);
      const world = unprojectCursor(camera, state.size, cssX, cssY);
      let seedX = world.x;
      let seedY = world.y;
      let seedZ = (camera as THREE.OrthographicCamera).isOrthographicCamera ? 0 : world.z;

      const gpu = gpuPick(state, cssX, cssY);
      if (gpu >= 0) {
        seedX = cloud.positions[gpu * 3];
        seedY = cloud.positions[gpu * 3 + 1];
        seedZ = cloud.positions[gpu * 3 + 2];
      }

      const visible = (idx: number) => isClusterVisible(hiddenClusters, cloud.clusters[idx]);
      const nearby = (
        index
          ? queryRadius(index, seedX, seedY, seedZ, radius)
          : gpu >= 0
            ? [{ idx: gpu, dist: 0 }]
            : []
      ).filter((h) => visible(h.idx));

      if (gpu >= 0 && visible(gpu) && !nearby.some((h) => h.idx === gpu)) {
        nearby.push({ idx: gpu, dist: 0 });
      }

      nearby.sort(
        (a, b) =>
          screenDistance(
            camera,
            state.size,
            cssX,
            cssY,
            cloud.positions[a.idx * 3],
            cloud.positions[a.idx * 3 + 1],
            cloud.positions[a.idx * 3 + 2],
          ) -
          screenDistance(
            camera,
            state.size,
            cssX,
            cssY,
            cloud.positions[b.idx * 3],
            cloud.positions[b.idx * 3 + 1],
            cloud.positions[b.idx * 3 + 2],
          ),
      );

      if (nearby.length === 0) return [];
      const primary = nearby[0].idx;
      const overlapR = baseSize * 1.4;
      const stacked = nearby
        .filter((h) => {
          const dx = cloud.positions[h.idx * 3] - cloud.positions[primary * 3];
          const dy = cloud.positions[h.idx * 3 + 1] - cloud.positions[primary * 3 + 1];
          const dz = cloud.positions[h.idx * 3 + 2] - cloud.positions[primary * 3 + 2];
          return dx * dx + dy * dy + dz * dz <= overlapR * overlapR;
        })
        .map((h) => h.idx);
      return stacked.length > 0 ? stacked : [primary];
    },
    [baseSize, cloud, extent, gpuPick, index, hiddenClusters],
  );

  const hideHover = useCallback(() => {
    const el = hoverEl.current;
    if (el) el.style.display = "none";
    if (useVectorStore.getState().hoverIndex !== null) setHoverIndex(null);
  }, [setHoverIndex]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const x = e.nativeEvent.offsetX;
      const y = e.nativeEvent.offsetY;
      cancelAnimationFrame(hoverRaf.current);
      hoverRaf.current = requestAnimationFrame(() => {
        const state = glRef.current;
        const el = hoverEl.current;
        if (!state || !cloud || !el) return;
        const hits = resolveHits(state, x, y);
        if (hits.length === 0) {
          hideHover();
          return;
        }
        const primary = hits[0];
        if (useVectorStore.getState().hoverIndex !== primary) {
          setHoverIndex(primary);
        }
        fillTooltip(
          el,
          x,
          y,
          hits.map((idx) => ({
            title: pointLabel(cloud.labels, cloud.ids, idx),
            hint: cloud.labels[idx] ? `id: ${cloud.ids[idx]}` : undefined,
          })),
        );
      });
    },
    [cloud, hideHover, resolveHits, setHoverIndex],
  );

  const onClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const [dx, dy] = downPos.current
        ? [e.nativeEvent.offsetX - downPos.current[0], e.nativeEvent.offsetY - downPos.current[1]]
        : [0, 0];
      if (Math.hypot(dx, dy) > 5) return;
      const state = glRef.current;
      if (!state || !cloud) return;
      const hits = resolveHits(state, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
      if (hits.length > 0) {
        const idx = hits[0];
        selectPoint(cloud.ids[idx], [
          cloud.positions[idx * 3],
          cloud.positions[idx * 3 + 1],
          cloud.positions[idx * 3 + 2],
        ]);
      } else {
        selectPoint(null);
      }
    },
    [cloud, resolveHits, selectPoint],
  );

  return (
    <div
      className="absolute inset-0"
      style={{
        background: "radial-gradient(ellipse at 50% 38%, #101033 0%, #07071a 42%, #03030c 78%)",
      }}
    >
      <Canvas
        dpr={CANVAS_DPR}
        gl={CANVAS_GL}
        onCreated={(state) => {
          glRef.current = state;
        }}
        onPointerMove={onPointerMove}
        onPointerDown={(e) => {
          downPos.current = [e.nativeEvent.offsetX, e.nativeEvent.offsetY];
        }}
        onClick={onClick}
        onPointerLeave={hideHover}
      >
        {viewMode === "2d" ? (
          <>
            <OrthographicCamera ref={cameraRef as never} makeDefault near={0.1} far={10000} />
            <MapControls
              ref={controlsRef as never}
              makeDefault
              enableRotate={false}
              screenSpacePanning
              enableDamping
              dampingFactor={0.1}
              zoomSpeed={1.1}
            />
          </>
        ) : (
          <>
            <PerspectiveCamera
              ref={cameraRef as never}
              makeDefault
              fov={50}
              near={0.01}
              far={1000000}
            />
            <OrbitControls
              ref={controlsRef as never}
              makeDefault
              enableDamping
              dampingFactor={0.08}
              zoomSpeed={1.1}
            />
          </>
        )}

        <UniformSync material={pointMaterial} baseSize={baseSize} cameraRef={cameraRef} />
        <CameraRig
          viewMode={viewMode}
          extent={extent}
          center={center}
          controlsRef={controlsRef}
          cameraRef={cameraRef}
        />

        {geometry && <points geometry={geometry} material={pointMaterial} frustumCulled={false} />}
        <group ref={overlaysRef}>
          {cloud && extent > 0 && (
            <BackgroundWeb
              positions={cloud.positions}
              colors={cloud.colors}
              count={cloud.count}
              extent={extent}
            />
          )}
          <HoverWeb index={index} baseSize={baseSize} extent={extent} />
          <SelectionWeb baseSize={baseSize} />
        </group>

        <FrameCounter renderTimes={renderTimes} />
      </Canvas>

      <div
        ref={hoverEl}
        className="pointer-events-none absolute z-30 hidden max-w-[16rem] rounded-md border border-white/15 bg-black/80 px-2.5 py-1.5 font-mono text-xs shadow-lg backdrop-blur-sm"
      />
    </div>
  );
}

function FrameCounter({ renderTimes }: { renderTimes: React.RefObject<number[]> }) {
  useFrame(() => {
    renderTimes.current.push(performance.now());
  });
  return null;
}
