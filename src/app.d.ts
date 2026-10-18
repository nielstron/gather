import type { Member } from './lib/types';

declare global {
  namespace App {
    interface PageState {
      modalIds?: string[];
    }
    interface Locals {
      user: Member | null;
    }
  }
}

export {};
