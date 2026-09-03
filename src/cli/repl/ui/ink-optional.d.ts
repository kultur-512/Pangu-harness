// src/cli/repl/ui/ink-optional.d.ts
// Ambient declarations for optional UI dependencies (ink + react).
// These allow TypeScript to compile cleanly even when ink/react are not installed
// (they live in optionalDependencies).
// At runtime, startInkUI.ts will dynamically import the real modules when available.

declare module 'ink' {
  export const Box: any;
  export const Text: any;
  export const render: any;
  export const useInput: any;
  export const useStdout: any;
  export const useApp: any;
  const _default: any;
  export default _default;
}

declare module 'react' {
  export const createElement: any;
  export const Fragment: any;
  export const useReducer: any;
  export const useEffect: any;
  export const useState: any;
  export const useCallback: any;
  export const useMemo: any;
  export const useRef: any;
  const _default: any;
  export default _default;

  export type FC<P = {}> = any;
  export type ReactNode = any;
}
