import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// Transactions in the tests go through simulate -> wallet -> receipt -> refetch; allow a few seconds.
configure({ asyncUtilTimeout: 8000 });
