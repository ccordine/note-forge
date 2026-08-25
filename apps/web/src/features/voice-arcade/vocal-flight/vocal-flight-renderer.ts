import type {
  VocalControlVector,
  VocalFlightCourseState,
  VocalFlightState,
  VocalFlightGate,
} from "./types";
import { clamp } from "@/lib/numeric";
import { vocalFlightGateCenter } from "./courses";

export interface VocalFlightRenderScene {
  readonly flight: Readonly<VocalFlightState>;
  readonly course: Readonly<VocalFlightCourseState> | null;
  readonly control: Readonly<VocalControlVector>;
  readonly linkState: "voice-off" | "opening" | "error" | "calibrating" | "ready" | "silence";
}

interface ProjectedGate {
  readonly gate: Readonly<VocalFlightGate>;
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly depth: number;
}

function projectGate(
  gate: Readonly<VocalFlightGate>,
  index: number,
  flight: Readonly<VocalFlightState>,
  width: number,
  height: number,
): ProjectedGate | null {
  const relativeX = gate.center.x - flight.position.x;
  const relativeY = gate.center.y - flight.position.y;
  const relativeZ = gate.center.z - flight.position.z;
  const sine = Math.sin(flight.headingRadians);
  const cosine = Math.cos(flight.headingRadians);
  const depth = relativeZ * cosine + relativeX * sine;
  if (depth <= 2 || depth > 850) return null;
  const side = relativeX * cosine - relativeZ * sine;
  const focalLength = Math.min(width, height * 1.65) * 1.18;
  const scale = focalLength / depth;
  return {
    gate,
    index,
    x: width / 2 + side * scale,
    y: height / 2 - relativeY * scale + flight.pitchRadians * height * 0.72,
    radius: gate.radius * scale,
    depth,
  };
}

function drawEnvironment(
  context: CanvasRenderingContext2D,
  flight: Readonly<VocalFlightState>,
  width: number,
  height: number,
): void {
  const horizonOffset = clamp(flight.pitchRadians * height * 0.72, -height, height);
  const sky = context.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, "#3979a8");
  sky.addColorStop(.48, "#82c8d8");
  sky.addColorStop(.68, "#e9dca7");
  sky.addColorStop(1, "#172924");
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height);

  context.save();
  context.translate(width / 2, height / 2 + horizonOffset);
  context.rotate(-flight.rollRadians);
  context.fillStyle = "#183b37";
  context.fillRect(-width * 1.4, 0, width * 2.8, height * 1.5);
  context.strokeStyle = "rgba(160, 238, 225, .2)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(-width * 1.4, 0);
  context.lineTo(width * 1.4, 0);
  context.stroke();
  for (let index = 1; index <= 9; index += 1) {
    const y = height * (1 - 1 / (1 + index * .22));
    context.strokeStyle = `rgba(98, 216, 200, ${.13 - index * .008})`;
    context.beginPath();
    context.moveTo(-width, y);
    context.lineTo(width, y);
    context.stroke();
  }
  context.restore();

  const cloudOffset = (flight.distanceTraveled * 1.8) % (width + 240);
  context.fillStyle = "rgba(244, 249, 238, .35)";
  for (const [x, y, size] of [[.18, .19, 52], [.68, .13, 34], [.9, .3, 46]] as const) {
    context.beginPath();
    context.ellipse((x * width - cloudOffset + width + 240) % (width + 240) - 120, y * height, size, size * .32, 0, 0, Math.PI * 2);
    context.fill();
  }
}

function drawGates(
  context: CanvasRenderingContext2D,
  scene: Readonly<VocalFlightRenderScene>,
  width: number,
  height: number,
): void {
  if (scene.course === null) return;
  const projectedInCourseOrder = scene.course.definition.gates
    .map((gate, index) => projectGate({
      ...gate,
      center: vocalFlightGateCenter(gate, scene.course!.sampleSeconds),
    }, index, scene.flight, width, height))
    .filter((gate): gate is ProjectedGate => gate !== null && gate.radius > 2);
  if (scene.course.definition.visual === "tunnel" && projectedInCourseOrder.length > 1) {
    context.save();
    context.strokeStyle = "rgba(94, 232, 255, .16)";
    context.lineCap = "round";
    for (let index = 1; index < projectedInCourseOrder.length; index += 1) {
      const previous = projectedInCourseOrder[index - 1]!;
      const current = projectedInCourseOrder[index]!;
      context.lineWidth = Math.max(6, (previous.radius + current.radius) * 1.5);
      context.beginPath();
      context.moveTo(previous.x, previous.y);
      context.lineTo(current.x, current.y);
      context.stroke();
    }
    context.restore();
  }
  const activeGate = scene.course.definition.gates[scene.course.nextGateIndex];
  const projected = projectedInCourseOrder
    .sort((left, right) => right.depth - left.depth);
  for (const view of projected) {
    const active = view.index === scene.course.nextGateIndex
      || activeGate?.choiceGroup !== undefined
        && view.gate.choiceGroup === activeGate.choiceGroup;
    const passed = view.index < scene.course.nextGateIndex;
    context.save();
    context.globalAlpha = passed ? .16 : clamp(1.4 - view.depth / 850, .3, 1);
    context.strokeStyle = active ? "#d9ff50" : "#5ee8ff";
    context.lineWidth = active ? clamp(view.radius * .14, 3, 12) : clamp(view.radius * .08, 2, 8);
    context.shadowColor = active ? "rgba(217, 255, 80, .75)" : "rgba(94, 232, 255, .65)";
    context.shadowBlur = active ? 18 : 10;
    context.beginPath();
    context.ellipse(view.x, view.y, view.radius, view.radius * .92, 0, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }
}

function drawAttitudeReference(
  context: CanvasRenderingContext2D,
  flight: Readonly<VocalFlightState>,
  width: number,
  height: number,
): void {
  context.save();
  context.translate(width / 2, height * .52);
  context.rotate(-flight.rollRadians);
  context.strokeStyle = "rgba(245, 250, 235, .78)";
  context.lineWidth = Math.max(1.5, width / 480);
  context.beginPath();
  context.moveTo(-width * .11, 0);
  context.lineTo(-width * .025, 0);
  context.lineTo(0, 8);
  context.lineTo(width * .025, 0);
  context.lineTo(width * .11, 0);
  context.stroke();
  context.restore();

  const noseY = height * .9;
  context.fillStyle = "rgba(7, 17, 20, .88)";
  context.strokeStyle = "rgba(94, 232, 255, .72)";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(width * .22, height);
  context.lineTo(width * .43, noseY);
  context.lineTo(width * .49, noseY - height * .1);
  context.lineTo(width * .51, noseY - height * .1);
  context.lineTo(width * .57, noseY);
  context.lineTo(width * .78, height);
  context.closePath();
  context.fill();
  context.stroke();
}

function drawInactiveVeil(
  context: CanvasRenderingContext2D,
  scene: Readonly<VocalFlightRenderScene>,
  width: number,
  height: number,
): void {
  if (scene.control.active) return;
  context.fillStyle = "rgba(4, 9, 11, .14)";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "rgba(246, 244, 231, .74)";
  context.font = `${Math.max(10, width / 70)}px ui-monospace, monospace`;
  context.textAlign = "center";
  const label = {
    "voice-off": "VOICE INPUT OFF · ENABLE IN THE GLOBAL HEADER",
    opening: "VOICE INPUT OPENING",
    error: "VOICE INPUT NEEDS ATTENTION",
    calibrating: "CALIBRATING VOCAL CENTER",
    ready: "VOCAL CONTROLS READY",
    silence: "SILENCE · CONTROLS NEUTRAL",
  }[scene.linkState];
  context.fillText(label, width / 2, height * .12);
}

export function renderVocalFlight(
  context: CanvasRenderingContext2D,
  scene: Readonly<VocalFlightRenderScene>,
  width: number,
  height: number,
): void {
  context.clearRect(0, 0, width, height);
  drawEnvironment(context, scene.flight, width, height);
  drawGates(context, scene, width, height);
  drawAttitudeReference(context, scene.flight, width, height);
  drawInactiveVeil(context, scene, width, height);
}
