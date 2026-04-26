import { Suspense } from 'react';
import { DataCenterClient } from './DataCenterClient';

export default function DataCenterPage() {
  return (
    <Suspense fallback={<main className="shell">Loading data center...</main>}>
      <DataCenterClient />
    </Suspense>
  );
}
