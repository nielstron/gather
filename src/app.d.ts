import type { Member } from './lib/types';

declare global {
  namespace App {
    interface Locals {
      user: Member | null;
    }
  }
}

export {};
