import {validateConfig} from '../extension/policy.js';
let input='';for await(const chunk of process.stdin)input+=chunk;
try{console.log(JSON.stringify(validateConfig(JSON.parse(input))));}catch(e){console.error(e.message);process.exitCode=1;}
