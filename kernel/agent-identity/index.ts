/**
 * lib/agent-identity/index.ts — barrel export for Agent Identity primitives.
 *
 * Public surface:
 *   • InMemoryIdentityStore — reference IdentityStore implementation
 *   • buildDelegationChain — validate a delegation chain
 *   • requireValidDelegation — GuardPolicy for autonomous action validation
 *   • All types + IdentityError
 */

export { InMemoryIdentityStore } from "./identity.ts";
export { buildDelegationChain, requireValidDelegation } from "./delegation.ts";
export { IdentityError } from "./types.ts";
export type {
  AgentType,
  AgentIdentity,
  IdentityStore,
  IdentityErrorCode,
} from "./types.ts";
