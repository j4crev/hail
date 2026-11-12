import {expect,it} from 'vitest';
import {BUNDLED_IMAGE_LIMITS,encodeBase64Url,validateJpegStructure} from '@racrproto/codec/content';
import vectors from '../../../spec/vectors/attachment-images.json';
import {renderBody} from '../src/rendering.js';

/** The frozen JPEG from the shared attachment vectors. */
const jpeg=Uint8Array.from(vectors.records.find(record=>record.id==='baseline.jpg')!.fileHex.match(/../g)!,byte=>parseInt(byte,16));
const base64url=encodeBase64Url(jpeg);
const asset=(overrides:Record<string,unknown>={})=>({id:'photo',role:'image',media_type:'image/jpeg',loading:'bundled',size:jpeg.length,
  ...validateJpegStructure(jpeg),data:base64url,...overrides});
const body=(assets:unknown[],blocks:unknown[])=>({version:1,profile:'spt-3',assets:{version:1,assets},blocks});
const image={_type:'spt.image',asset:'photo',alt:'A photograph'};

it('renders a bundled JPEG under its own media type',()=>{
  const rendered=renderBody(body([asset()],[image]));
  expect(rendered.blocks).toHaveLength(1);
  expect(JSON.stringify(rendered.blocks[0])).toContain(`data:image/jpeg;base64,${base64url.replaceAll('-','+').replaceAll('_','/')}`);
});

it('accepts the protocol image budget and refuses formats and sizes outside it',()=>{
  const many=Array.from({length:BUNDLED_IMAGE_LIMITS.maximumAssets},(_,index)=>asset({id:`photo-${index}`}));
  expect(renderBody(body(many,many.map(entry=>({...image,asset:entry.id})))).blocks).toHaveLength(BUNDLED_IMAGE_LIMITS.maximumAssets);
  expect(()=>renderBody(body([...many,asset({id:'extra'})],[image]))).toThrow();
  for(const overrides of [{media_type:'image/gif'},{media_type:'image/svg+xml'},{size:BUNDLED_IMAGE_LIMITS.message.bytes+1},{width:2401}])
    expect(()=>renderBody(body([asset(overrides)],[image]))).toThrow();
});
