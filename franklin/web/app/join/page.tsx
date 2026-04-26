import { Suspense } from 'react';
import { JoinClient } from './JoinClient';

export default function JoinPage() {
  return (
    <Suspense fallback={<main className="shell">Loading sessions...</main>}>
      <JoinClient />
    </Suspense>
  );
}
