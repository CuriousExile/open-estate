// Duplikat-Erkennung: reine Logik (duplicate-detection Req 3). Normalization, Merkmalsprofil,
// Blockschlüssel and Bewertung are pure functions, so the Management_API, the import pipeline,
// the Duplikat_Abgleich and the frontend all decide identically.
export * from './blocks';
export * from './config';
export * from './normalize';
export * from './profile';
export * from './reasons';
export * from './score';
export * from './simhash';
