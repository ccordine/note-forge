export interface UserOwnedLifetimeSourceRecord {
  readonly relativePath: string;
  readonly source: string;
}

export interface UserOwnedLifetimeContract {
  readonly path: string;
  readonly reducer: string;
  readonly terminalField: string;
  readonly terminalValues: readonly string[];
  readonly allowedActions: readonly string[];
  readonly requiredActions: readonly string[];
}

export const USER_OWNED_LIVE_SESSION_CONTRACTS:
  readonly Readonly<UserOwnedLifetimeContract>[];

export function auditUserOwnedLiveLifetime(
  records: readonly Readonly<UserOwnedLifetimeSourceRecord>[],
  contracts?: readonly Readonly<UserOwnedLifetimeContract>[],
): readonly string[];
