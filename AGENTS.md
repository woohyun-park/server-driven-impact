# Project guidance

## Development stage

- This project is in an early development stage. Unless the user explicitly requests backward compatibility, prefer the simplest coherent current design even when it changes existing APIs or behavior.
- Do not add feature flags, compatibility branches, shims, dual paths, or legacy tests solely to preserve backward compatibility during this stage.
- Keep safety fallbacks that prevent incorrect impact or cache invalidation; this instruction removes compatibility work, not correctness guarantees.
