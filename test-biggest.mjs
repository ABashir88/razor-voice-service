import { createSalesforceClient } from './src/integrations/salesforce.js';

const sf = createSalesforceClient();

console.log('=== RAW getBiggestDeal ===');
const big = await sf.getBiggestDeal();
console.log(JSON.stringify(big, null, 2));
