import { createRoot } from 'react-dom/client';
import '@excalidraw/excalidraw/index.css';
import App from './App';
import DiagramList from './DiagramList';

// `/` lists the diagrams, `/d/<id>` opens one.
const m = /^\/d\/([^/]+)/.exec(location.pathname);

createRoot(document.getElementById('root')!).render(
  m ? <App diagramId={decodeURIComponent(m[1])} /> : <DiagramList />
);
