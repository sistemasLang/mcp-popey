/**
 * Identifier rules shared by the catalog (circuits.yaml) and the SQL compiler.
 * Anything that ever reaches SQL as an identifier must match IDENTIFIER_PATTERN.
 */
export const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
export const QUALIFIED_TABLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/;
export const CIRCUIT_ID_PATTERN = /^[a-z0-9_]{1,64}$/;
