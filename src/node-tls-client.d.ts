// The node-tls-client internals adapters/faceit.ts reaches past initTLS for — the package ships
// no typings beside dist/. Only the members used, as they exist at runtime in 2.1.0.

declare module "node-tls-client/dist/utils/native.js" {
  export class LibraryHandler {
    static path: string;
    static retrieveFileInfo(): unknown;
  }
}

declare module "node-tls-client/dist/lib/Client.js" {
  export class Client {
    // The worker pool — a Piscina instance, which is an EventEmitter.
    static getInstance(): { pool: import("node:events").EventEmitter };
  }
}

declare module "node-tls-client/dist/utils/download.js" {
  export class LibraryDownloader {
    static retrieveLibrary(file: unknown, libPath: string): Promise<boolean>;
  }
}
