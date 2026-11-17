// The board this session opened with open_diagram, and what the canvas
// server last said about it.
export type Board = {
  id: string;
  as: string;
  mode: 'writer' | 'reader';
  // From GET /api/diagrams/<id>/status; empty until the first poll answers.
  name: string;
  owner: string;
  unread: number;
  // The canvas server's port from server.json; 0 while no server answers.
  port: number;
};

declare module 'claude-code' {
  interface PluginState {
    'excalidraw-live': { board: Board | null; isHidden: boolean };
  }
}
