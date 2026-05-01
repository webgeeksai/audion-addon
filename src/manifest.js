export const manifest = {
  id: 'in.webgeeksai.audion',
  version: '0.1.0',
  name: 'Audion',
  description:
    'Audiobook discovery powered by Audnexus + Hardcover, streamed via Real-Debrid.',
  resources: ['catalog', 'meta', 'stream'],
  types: ['audiobook'],
  idPrefixes: ['audion:'],
  catalogs: [
    {
      type: 'audiobook',
      id: 'search',
      name: 'Search audiobooks',
      extra: [
        { name: 'search', isRequired: true },
        { name: 'skip', isRequired: false },
      ],
    },
    {
      type: 'audiobook',
      id: 'popular',
      name: 'Popular audiobooks',
      extra: [{ name: 'skip', isRequired: false }],
    },
  ],
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
  },
};
