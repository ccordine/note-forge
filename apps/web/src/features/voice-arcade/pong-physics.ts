import {
  createSeededRandom,
  normalizedSeed,
  type SeedValue,
} from "./model";

const EPSILON = 1e-9;

export interface PongConfig {
  playerPaddleX: number;
  opponentPaddleX: number;
  paddleWidth: number;
  paddleHeight: number;
  ballRadius: number;
  ballSpeed: number;
  aiSpeed: number;
  maximumBounceAngleRadians: number;
  winningScore: number;
  simulationStepSeconds: number;
  maximumDeltaSeconds: number;
}

export const DEFAULT_PONG_CONFIG = Object.freeze({
  playerPaddleX: 0.06,
  opponentPaddleX: 0.94,
  paddleWidth: 0.025,
  paddleHeight: 0.22,
  ballRadius: 0.018,
  ballSpeed: 0.48,
  aiSpeed: 0.38,
  maximumBounceAngleRadians: Math.PI * 0.36,
  winningScore: 7,
  simulationStepSeconds: 1 / 240,
  maximumDeltaSeconds: 2,
} as const satisfies PongConfig);

export interface PongBallState {
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
}

export type PongWinner = "player" | "opponent" | null;

export interface PongState {
  config: PongConfig;
  seed: number;
  status: "playing" | "finished";
  elapsedSeconds: number;
  playerPaddleY: number;
  opponentPaddleY: number;
  ball: PongBallState;
  playerScore: number;
  opponentScore: number;
  rally: number;
  serveIndex: number;
  winner: PongWinner;
}

export interface CreatePongOptions {
  seed?: SeedValue;
  serveToward?: "player" | "opponent";
  config?: Readonly<Partial<PongConfig>>;
}

export interface PongFrameInput {
  deltaSeconds: number;
  voicePaddleY: number;
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite.`);
}

function requireNonNegative(value: number, label: string): void {
  requireFinite(value, label);
  if (value < 0) throw new RangeError(`${label} cannot be negative.`);
}

function requirePositive(value: number, label: string): void {
  requireFinite(value, label);
  if (value <= 0) throw new RangeError(`${label} must be greater than zero.`);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function validatePongConfig(config: Readonly<PongConfig>): void {
  for (const [label, value] of [
    ["Player paddle X", config.playerPaddleX],
    ["Opponent paddle X", config.opponentPaddleX],
    ["Paddle width", config.paddleWidth],
    ["Paddle height", config.paddleHeight],
    ["Ball radius", config.ballRadius],
    ["Ball speed", config.ballSpeed],
    ["AI speed", config.aiSpeed],
    ["Maximum bounce angle", config.maximumBounceAngleRadians],
    ["Simulation step", config.simulationStepSeconds],
    ["Maximum delta", config.maximumDeltaSeconds],
  ] as const) requirePositive(value, label);
  if (config.playerPaddleX >= 0.5 || config.opponentPaddleX <= 0.5) {
    throw new RangeError("Pong paddles must remain on opposite sides of center court.");
  }
  if (config.paddleHeight >= 1 || config.paddleWidth >= 0.5 || config.ballRadius >= 0.25) {
    throw new RangeError("Pong dimensions must fit inside normalized court space.");
  }
  if (config.playerPaddleX - config.paddleWidth / 2 < 0
    || config.opponentPaddleX + config.paddleWidth / 2 > 1) {
    throw new RangeError("Pong paddles must fit inside the court.");
  }
  if (config.maximumBounceAngleRadians >= Math.PI / 2) {
    throw new RangeError("Pong maximum bounce angle must be less than PI / 2.");
  }
  if (!Number.isInteger(config.winningScore) || config.winningScore < 1) {
    throw new RangeError("Pong winning score must be a positive integer.");
  }
  if (config.simulationStepSeconds > config.maximumDeltaSeconds) {
    throw new RangeError("Pong simulation step cannot exceed the maximum frame delta.");
  }
}

function seededServe(
  seed: number,
  serveIndex: number,
  toward: "player" | "opponent",
  speed: number,
  maximumAngle: number,
): PongBallState {
  const rng = createSeededRandom(`${seed}:${serveIndex}`);
  const angle = (rng() * 0.7 - 0.35) * maximumAngle;
  const direction = toward === "player" ? -1 : 1;
  return {
    x: 0.5,
    y: 0.5,
    velocityX: direction * speed * Math.cos(angle),
    velocityY: speed * Math.sin(angle),
  };
}

export function createPongState(options: Readonly<CreatePongOptions> = {}): PongState {
  const config: PongConfig = { ...DEFAULT_PONG_CONFIG, ...options.config };
  validatePongConfig(config);
  const seed = normalizedSeed(options.seed ?? "voice-pong");
  const serveToward = options.serveToward
    ?? (createSeededRandom(seed)() < 0.5 ? "player" : "opponent");
  if (serveToward !== "player" && serveToward !== "opponent") {
    throw new RangeError(`Unknown Pong serve direction: ${String(serveToward)}`);
  }
  return {
    config,
    seed,
    status: "playing",
    elapsedSeconds: 0,
    playerPaddleY: 0.5,
    opponentPaddleY: 0.5,
    ball: seededServe(seed, 0, serveToward, config.ballSpeed, config.maximumBounceAngleRadians),
    playerScore: 0,
    opponentScore: 0,
    rally: 0,
    serveIndex: 0,
    winner: null,
  };
}

function clampPaddleY(value: number, config: Readonly<PongConfig>): number {
  return clamp(value, config.paddleHeight / 2, 1 - config.paddleHeight / 2);
}

function reflectBallFromHorizontalWalls(ball: PongBallState, radius: number): void {
  while (ball.y - radius < 0 || ball.y + radius > 1) {
    if (ball.y - radius < 0) {
      ball.y = radius + (radius - ball.y);
      ball.velocityY = Math.abs(ball.velocityY);
    }
    if (ball.y + radius > 1) {
      ball.y = 1 - radius - (ball.y + radius - 1);
      ball.velocityY = -Math.abs(ball.velocityY);
    }
  }
}

function bounceFromPaddle(
  ball: PongBallState,
  paddleY: number,
  direction: -1 | 1,
  rally: number,
  config: Readonly<PongConfig>,
): void {
  const relativeImpact = clamp((ball.y - paddleY) / (config.paddleHeight / 2), -1, 1);
  const angle = relativeImpact * config.maximumBounceAngleRadians;
  const speed = Math.min(config.ballSpeed * (1 + (rally + 1) * 0.025), config.ballSpeed * 1.6);
  ball.velocityX = direction * speed * Math.cos(angle);
  ball.velocityY = speed * Math.sin(angle);
}

function scorePongPoint(state: PongState, scorer: "player" | "opponent"): void {
  if (scorer === "player") state.playerScore += 1;
  else state.opponentScore += 1;
  state.rally = 0;
  state.serveIndex += 1;
  if (state.playerScore >= state.config.winningScore || state.opponentScore >= state.config.winningScore) {
    state.status = "finished";
    state.winner = state.playerScore >= state.config.winningScore ? "player" : "opponent";
    state.ball = { x: 0.5, y: 0.5, velocityX: 0, velocityY: 0 };
    return;
  }
  const serveToward = scorer === "player" ? "opponent" : "player";
  state.ball = seededServe(
    state.seed,
    state.serveIndex,
    serveToward,
    state.config.ballSpeed,
    state.config.maximumBounceAngleRadians,
  );
}

/** Advance normalized Pong physics using a voice-controlled player paddle. */
export function updatePongState(
  previous: Readonly<PongState>,
  input: Readonly<PongFrameInput>,
): PongState {
  requireNonNegative(input.deltaSeconds, "Pong frame delta");
  requireFinite(input.voicePaddleY, "Voice paddle position");
  validatePongConfig(previous.config);
  if (input.deltaSeconds > previous.config.maximumDeltaSeconds) {
    throw new RangeError("Pong frame delta exceeds the configured maximum.");
  }
  if (previous.status === "finished") return previous as PongState;

  const state: PongState = {
    ...previous,
    config: { ...previous.config },
    playerPaddleY: clampPaddleY(input.voicePaddleY, previous.config),
    ball: { ...previous.ball },
  };
  if (input.deltaSeconds === 0) return state;
  const stepCount = Math.ceil(input.deltaSeconds / state.config.simulationStepSeconds);
  const delta = input.deltaSeconds / stepCount;

  for (let stepIndex = 0; stepIndex < stepCount && state.status === "playing"; stepIndex += 1) {
    state.elapsedSeconds += delta;
    const aiDifference = state.ball.y - state.opponentPaddleY;
    const aiMovement = clamp(aiDifference, -state.config.aiSpeed * delta, state.config.aiSpeed * delta);
    state.opponentPaddleY = clampPaddleY(state.opponentPaddleY + aiMovement, state.config);

    const previousX = state.ball.x;
    state.ball.x += state.ball.velocityX * delta;
    state.ball.y += state.ball.velocityY * delta;
    reflectBallFromHorizontalWalls(state.ball, state.config.ballRadius);

    const playerSurface = state.config.playerPaddleX + state.config.paddleWidth / 2;
    const crossedPlayer = state.ball.velocityX < 0
      && previousX - state.config.ballRadius >= playerSurface - EPSILON
      && state.ball.x - state.config.ballRadius <= playerSurface + EPSILON;
    const insidePlayer = Math.abs(state.ball.y - state.playerPaddleY)
      <= state.config.paddleHeight / 2 + state.config.ballRadius;
    if (crossedPlayer && insidePlayer) {
      state.ball.x = playerSurface + state.config.ballRadius;
      bounceFromPaddle(state.ball, state.playerPaddleY, 1, state.rally, state.config);
      state.rally += 1;
    }

    const opponentSurface = state.config.opponentPaddleX - state.config.paddleWidth / 2;
    const crossedOpponent = state.ball.velocityX > 0
      && previousX + state.config.ballRadius <= opponentSurface + EPSILON
      && state.ball.x + state.config.ballRadius >= opponentSurface - EPSILON;
    const insideOpponent = Math.abs(state.ball.y - state.opponentPaddleY)
      <= state.config.paddleHeight / 2 + state.config.ballRadius;
    if (crossedOpponent && insideOpponent) {
      state.ball.x = opponentSurface - state.config.ballRadius;
      bounceFromPaddle(state.ball, state.opponentPaddleY, -1, state.rally, state.config);
      state.rally += 1;
    }

    if (state.ball.x + state.config.ballRadius < 0) {
      scorePongPoint(state, "opponent");
    } else if (state.ball.x - state.config.ballRadius > 1) {
      scorePongPoint(state, "player");
    }
  }

  return state;
}
