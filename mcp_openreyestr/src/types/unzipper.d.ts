// unzipper ships no types and @types/unzipper is not installed. The scripts build
// (tsconfig.scripts.json, noImplicitAny off) never needed this; services/registry-archive.ts
// is now in the main build because http-server.ts imports it.
declare module 'unzipper';
