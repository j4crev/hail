import {expect,it} from 'vitest';
import Ajv from 'ajv';
import schema from '../../../spec/schemas/jmap-account-object-v1.json';
import vectors from '../../../spec/vectors/jmap-account.json';
it('validates full account projections and excludes invitation secrets and malformed local state',()=>{
 const ajv=new Ajv();
 for(const vector of vectors.valid){const validate=ajv.compile({$ref:'#/definitions/'+vector.type,definitions:schema.definitions});expect(validate(vector.object),JSON.stringify(validate.errors)).toBe(true);}
 for(const vector of vectors.invalid){const validate=ajv.compile({$ref:'#/definitions/'+vector.type,definitions:schema.definitions});expect(validate(vector.object)).toBe(false);}
});
