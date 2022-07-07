declare module '*.svg' {
  // `string` since we're importing SVGs as their URLs with Vite
  const content: string;
  export default content;
}

interface NotificationMessage {
  type: 'success' | 'error' | 'info' | 'warn';
  message: string;
  tags?: string[];
  onClose?: () => void;
  choices?: { [labelKey: string]: () => void };
}
