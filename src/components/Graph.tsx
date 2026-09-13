"use client";

/**
 * The scene: one point of light per agent, a trail from the planner to each
 * one, and a pulse along that trail when the agent calls a tool. Everything is
 * driven by the playhead, so scrubbing backwards looks exactly like playing
 * forwards to that point.
 */

import { useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import * as THREE from "three";
import { formatClock, type AgentState } from "@/lib/trace/select";

const COLOUR = {
  pending: new THREE.Color("#3a4358"),
  active: new THREE.Color("#6ee7c0"),
  done: new THREE.Color("#7fd9a0"),
  waiting: new THREE.Color("#ffb07c"),
};

type Look = keyof typeof COLOUR;

/** Below this width the scene stacks into one column. */
const NARROW_PX = 560;

/** More steps than this and the ticks become a bar. */
const MAX_TICKS = 18;

/**
 * A soft radial falloff, drawn once and reused by every node. A plain sphere
 * with a flat material reads as a grey disc on a dark background, which is the
 * opposite of a glow.
 */
function glowTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2,
  );
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.22, "rgba(255,255,255,0.42)");
  gradient.addColorStop(0.55, "rgba(255,255,255,0.09)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function lookFor(state: AgentState, awaitingAgentId: string | null): Look {
  if (awaitingAgentId && state.agent.id === awaitingAgentId) return "waiting";
  return state.status === "done"
    ? "done"
    : state.status === "active"
      ? "active"
      : "pending";
}

/**
 * Deterministic layout. Wide viewports get the planner above an arc of
 * specialists. A phone gets a single column instead, because the arc puts the
 * outer agents past the edge of the frame however far the camera pulls back.
 */
function layout(
  states: AgentState[],
  narrow: boolean,
): Map<string, THREE.Vector3> {
  const positions = new Map<string, THREE.Vector3>();
  const roots = states.filter((s) => s.agent.parentId === null);
  const children = states.filter((s) => s.agent.parentId !== null);

  if (narrow) {
    // The cards under each node are fixed-size DOM, so the column has to
    // leave room for the last one rather than filling the frame edge to edge.
    const rows = roots.length + children.length;
    const gap = Math.min(1.5, 6 / Math.max(rows, 1));
    const top = ((rows - 1) / 2) * gap;
    [...roots, ...children].forEach((state, i) => {
      positions.set(state.agent.id, new THREE.Vector3(0, top - i * gap, 0));
    });
    return positions;
  }

  roots.forEach((state, i) => {
    const offset = (i - (roots.length - 1) / 2) * 3;
    positions.set(state.agent.id, new THREE.Vector3(offset, 1.75, 0));
  });

  // Children sit on one shallow arc at the same depth, so no node looks
  // bigger than another just because perspective put it nearer.
  const spread = Math.max(children.length - 1, 1);
  children.forEach((state, i) => {
    const t = children.length === 1 ? 0.5 : i / spread;
    const x = (t - 0.5) * 6.2;
    const lift = Math.cos((t - 0.5) * Math.PI) * 0.45;
    positions.set(state.agent.id, new THREE.Vector3(x, -1.5 + lift, 0));
  });

  return positions;
}

function Node({
  state,
  position,
  look,
  onSelect,
  onSeek,
}: {
  state: AgentState;
  position: THREE.Vector3;
  look: Look;
  onSelect: (agentId: string) => void;
  onSeek: (ms: number) => void;
}) {
  const core = useRef<THREE.Mesh>(null);
  const glow = useRef<THREE.Sprite>(null);
  const level = useRef(0.12);
  const texture = useMemo(() => glowTexture(), []);
  useEffect(() => () => texture.dispose(), [texture]);

  const target =
    look === "waiting"
      ? 1
      : state.firing
        ? 0.95
        : state.status === "active"
          ? 0.55
          : state.status === "done"
            ? 0.32
            : 0.12;

  useFrame((_, delta) => {
    level.current += (target - level.current) * Math.min(1, delta * 6);
    const l = level.current;
    if (core.current) {
      const m = core.current.material as THREE.MeshBasicMaterial;
      m.color.copy(COLOUR[look]);
      m.opacity = 0.45 + l * 0.55;
      core.current.scale.setScalar(0.8 + l * 0.45);
    }
    if (glow.current) {
      const m = glow.current.material as THREE.SpriteMaterial;
      m.color.copy(COLOUR[look]);
      m.opacity = 0.18 + l * 0.62;
      glow.current.scale.setScalar(0.9 + l * 1.1);
    }
  });

  return (
    <group position={position}>
      <sprite ref={glow}>
        <spriteMaterial
          map={texture}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </sprite>
      <mesh ref={core}>
        <sphereGeometry args={[0.115, 24, 24]} />
        <meshBasicMaterial transparent depthWrite={false} />
      </mesh>
      <Html
        center
        position={[0, -0.42, 0]}
        // Keep labels under the decision card rather than through it.
        zIndexRange={[20, 0]}
        style={{ userSelect: "none" }}
      >
        <div className="node-card">
          <button
            className="mono node-label"
            onClick={() => onSelect(state.agent.id)}
            title={`What ${state.agent.name} was told to do`}
            style={{
              color:
                look === "pending"
                  ? "#5b6072"
                  : `#${COLOUR[look].getHexString()}`,
              opacity: look === "pending" ? 0.6 : 0.95,
            }}
          >
            {state.agent.name}
          </button>

          {/* What it is doing right now, or the last thing it did. Never what
              it is about to do: the scene stays honest about time. */}
          <div
            className={`node-now ${state.status === "pending" ? "waiting" : ""}`}
          >
            {state.latest ? state.latest.label : "not started"}
          </div>

          {state.steps.length > 0 && (
            <div className="node-steps">
              {/* One tick per step reads well for a handful. A real run can
                  give one agent a hundred, where a wall of dashes says less
                  than a bar does. */}
              {state.steps.length <= MAX_TICKS ? (
                state.steps.map((step, i) => (
                  <button
                    key={step.id}
                    className={`tick ${i < state.doneCount ? "done" : ""} ${
                      step.kind === "decision" ? "gate" : ""
                    }`}
                    title={`${formatClock(step.tMs)}  ${step.label}`}
                    onClick={() => onSeek(step.tMs)}
                  />
                ))
              ) : (
                <button
                  className="node-bar"
                  title={`${state.doneCount} of ${state.steps.length} steps. Click to jump.`}
                  onClick={(e) => {
                    const box = e.currentTarget.getBoundingClientRect();
                    const ratio = (e.clientX - box.left) / Math.max(box.width, 1);
                    const index = Math.min(
                      state.steps.length - 1,
                      Math.max(0, Math.round(ratio * (state.steps.length - 1))),
                    );
                    onSeek(state.steps[index].tMs);
                  }}
                >
                  <span
                    className="node-bar-fill"
                    style={{
                      width: `${(state.doneCount / state.steps.length) * 100}%`,
                    }}
                  />
                </button>
              )}
              <span className="node-count mono">
                {state.doneCount}/{state.steps.length}
              </span>
            </div>
          )}
        </div>
      </Html>
    </group>
  );
}

function Trail({
  from,
  to,
  look,
  firing,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  look: Look;
  firing: boolean;
}) {
  const points = useMemo(() => {
    const mid = from
      .clone()
      .lerp(to, 0.5)
      .add(new THREE.Vector3(0, -0.35, 0.25));
    return new THREE.QuadraticBezierCurve3(from, mid, to).getPoints(40);
  }, [from, to]);

  const opacity = look === "pending" ? 0.1 : firing ? 0.75 : 0.28;

  return (
    <Line
      points={points}
      color={`#${COLOUR[look].getHexString()}`}
      lineWidth={firing ? 1.8 : 1}
      transparent
      opacity={opacity}
      depthWrite={false}
    />
  );
}

/** A bead of light travelling the trail while a tool call is in flight. */
function Spark({
  from,
  to,
  active,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  active: boolean;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const curve = useMemo(() => {
    const mid = from
      .clone()
      .lerp(to, 0.5)
      .add(new THREE.Vector3(0, -0.35, 0.25));
    return new THREE.QuadraticBezierCurve3(from, mid, to);
  }, [from, to]);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    ref.current.visible = active;
    if (!active) return;
    const t = (clock.getElapsedTime() * 0.9) % 1;
    ref.current.position.copy(curve.getPoint(t));
  });

  return (
    <mesh ref={ref} visible={false}>
      <sphereGeometry args={[0.055, 12, 12]} />
      <meshBasicMaterial
        color="#6ee7c0"
        transparent
        opacity={0.9}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  );
}

/**
 * The one place that moves the camera: a slow drift, a little parallax from
 * the pointer, and enough pull-back that the whole graph fits the frame. A
 * narrow viewport stacks into a column, which needs less room than the arc.
 */
function Drift() {
  useFrame(({ camera, clock, pointer, size }) => {
    const t = clock.getElapsedTime();
    const aspect = size.width / Math.max(size.height, 1);
    const targetZ =
      size.width < NARROW_PX
        ? 9.2
        : 7.4 / Math.min(1, Math.max(aspect / 1.25, 0.55));

    camera.position.x += (pointer.x * 0.55 - camera.position.x) * 0.02;
    camera.position.y +=
      (pointer.y * 0.35 + Math.sin(t * 0.22) * 0.12 - camera.position.y) * 0.02;
    camera.position.z += (targetZ - camera.position.z) * 0.06;
    camera.lookAt(0, 0, 0);
  });
  return null;
}

function Scene({
  states,
  awaitingAgentId,
  onSelectAgent,
  onSeek,
}: {
  states: AgentState[];
  awaitingAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  onSeek: (ms: number) => void;
}) {
  const width = useThree((s) => s.size.width);
  const positions = useMemo(
    () => layout(states, width < NARROW_PX),
    [states, width],
  );

  return (
    <>
      {states.map((state) => {
        const parentId = state.agent.parentId;
        if (!parentId) return null;
        const from = positions.get(parentId);
        const to = positions.get(state.agent.id);
        if (!from || !to) return null;
        const look = lookFor(state, awaitingAgentId);
        return (
          <group key={`trail-${state.agent.id}`}>
            <Trail from={from} to={to} look={look} firing={state.firing} />
            <Spark from={from} to={to} active={state.firing} />
          </group>
        );
      })}
      {states.map((state) => {
        const position = positions.get(state.agent.id);
        if (!position) return null;
        return (
          <Node
            key={state.agent.id}
            state={state}
            position={position}
            look={lookFor(state, awaitingAgentId)}
            onSelect={onSelectAgent}
            onSeek={onSeek}
          />
        );
      })}
    </>
  );
}

export default function Graph({
  states,
  awaitingAgentId,
  onSelectAgent,
  onSeek,
}: {
  states: AgentState[];
  awaitingAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  onSeek: (ms: number) => void;
}) {
  return (
    <Canvas
      dpr={[1, 2]}
      camera={{ position: [0, 0, 7.4], fov: 45 }}
      gl={{ antialias: true }}
      style={{ background: "transparent" }}
    >
      <Drift />
      <Scene
        states={states}
        awaitingAgentId={awaitingAgentId}
        onSelectAgent={onSelectAgent}
        onSeek={onSeek}
      />
    </Canvas>
  );
}
