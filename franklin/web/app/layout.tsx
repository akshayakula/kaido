import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Franklin · Grid sensor + audio fault detection', template: '%s · Franklin' },
  description:
    'Live transformer health from Pi sensors (temp, humidity, microphone) fused with SAM-Audio fault segmentation on a Lambda Cloud GPU. Two-way command channel from cloud to Pi.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
