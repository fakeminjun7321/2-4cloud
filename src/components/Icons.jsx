import React from 'react';

const paths = {
  search: <><circle cx="11" cy="11" r="7" /><path d="m16.2 16.2 4.5 4.5" /></>,
  file: <><path d="M7 2.8h7l5 5V21H7a2 2 0 0 1-2-2V4.8a2 2 0 0 1 2-2Z" /><path d="M14 3v5h5M9 12h6M9 16h6" /></>,
  chevronLeft: <path d="m14.5 5-7 7 7 7" />,
  chevronRight: <path d="m9.5 5 7 7-7 7" />,
  close: <path d="M5 5 19 19M19 5 5 19" />,
  plus: <path d="M12 5v14M5 12h14" />,
  download: <><path d="M12 3v12m-4-4 4 4 4-4M4 18v3h16v-3" /></>,
};

export function Icon({ name, size = 20, ...props }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {paths[name]}
    </svg>
  );
}
