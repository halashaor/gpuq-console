import {sessionColumns, sessionFrom} from './session-reader.mjs';
import {permissionResourceFor} from '../../domain/data-source.mjs';

function resourceParameters(request){const r=permissionResourceFor(request);return [r.kind,r.machineId,r.sourceId,r.version];}

export class SqliteDataAuthority{
  constructor({database}){
    // One statement observes identity and both grants consistently.
    this.read=database.prepare(`SELECT ${sessionColumns},r.id resource_id,r.visibility,r.owner_id,m.enabled machine_enabled,
      EXISTS(SELECT 1 FROM v2_machine_grants g WHERE g.account_id=a.id AND g.machine_id=?) machine_granted,
      EXISTS(SELECT 1 FROM v2_data_readers d WHERE d.account_id=a.id AND d.resource_id=r.id) reader_granted
      FROM v2_accounts a LEFT JOIN v2_sessions s ON s.account_id=a.id AND s.id=?
      LEFT JOIN v2_machines m ON m.id=?
      LEFT JOIN v2_data_resources r ON r.kind=? AND r.machine_id IS ? AND r.source_id=? AND r.version IS ?
      WHERE a.id=?`);
  }
  snapshot(actor,request){
    const row=this.read.get(request.machineId,actor.sessionId,request.machineId,...resourceParameters(request),actor.id);
    return {session:sessionFrom(row),machineEnabled:row?.machine_enabled===1,machineGranted:row?.machine_granted===1,
      source:row?.resource_id?{visibility:row.visibility,ownerId:row.owner_id,readerGranted:row.reader_granted===1}:null};
  }
}

export class SqliteSourceCatalog{
  constructor({database}){
    this.findSource=database.prepare(`SELECT b.host_path,b.ready FROM v2_source_bindings b
      JOIN v2_data_resources r ON r.id=b.resource_id
      WHERE r.kind=? AND r.machine_id IS ? AND r.source_id=? AND r.version IS ?
        AND b.machine_id=? AND b.storage_kind=?`);
  }
  find(request){
    const row=this.findSource.get(...resourceParameters(request),request.machineId,request.source.kind);
    return row?{hostPath:row.host_path,ready:row.ready===1}:null;
  }
}
