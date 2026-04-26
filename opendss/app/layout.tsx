import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'OpenDSS Data-Center Agent Demo',
  description: 'Live grid-agent demo with data-center agents, Upstash session state, and mock OpenDSS.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
