import pg from 'pg';

// Les montants sont des entiers en unités mineures, très en dessous de 2^53 : on les lit comme des nombres.
pg.types.setTypeParser(20, (value) => Number(value));
