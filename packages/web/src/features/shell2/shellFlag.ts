/**
 * The client flag that swaps the shell. Turn it on with `?ff=shell_v2` or
 * `setFeatureFlag('shell_v2', true)`. Lives in its own module so a page outside
 * the shell (the login page) can read it without pulling both shells into its chunk.
 */
export const SHELL_V2_FLAG = 'shell_v2';
