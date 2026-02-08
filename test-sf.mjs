import { createSalesforceClient } from './src/integrations/salesforce.js';

const sf = createSalesforceClient();

console.log('=== TEST 1: getPipeline ===');
const p = await sf.getPipeline();
console.log(JSON.stringify(p, null, 2));

console.log('\n=== TEST 2: getDealsClosing(this_week) ===');
const w = await sf.getDealsClosing('this_week');
console.log(JSON.stringify(w, null, 2));

console.log('\n=== TEST 3: getDealsClosing(this_month) ===');
const m = await sf.getDealsClosing('this_month');
console.log(JSON.stringify(m, null, 2));

console.log('\n=== METHODS ===');
const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(sf));
console.log(methods.filter(x => x !== 'constructor'));
