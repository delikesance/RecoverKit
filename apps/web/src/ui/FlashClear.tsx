'use client';

import { useEffect } from 'react';
import { clearFlashAction } from '@/app/app/flash-actions';

/** Rendu seulement quand un flash vient d'être affiché : le cookie est effacé, le message ne revient pas. */
export function FlashClear() {
  useEffect(() => {
    void clearFlashAction();
  }, []);
  return null;
}
