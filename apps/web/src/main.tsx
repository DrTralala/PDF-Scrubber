import { createRoot } from 'react-dom/client';

import { App } from './app';

const root = document.getElementById('root');
if (root === null) throw new Error('PDF-Scrubber root element is missing');
createRoot(root).render(<App />);
