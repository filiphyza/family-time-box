import type { FamilyTreeData } from '../types';
import { emptyFamilyTree, validateFamilyTree } from '../utils/familyTree';

// A separate database leaves the existing photo database and its migrations untouched.
export class BrowserFamilyTreeStorage {
  private database?: Promise<IDBDatabase>;

  private open(): Promise<IDBDatabase> {
    if (!this.database) {
      this.database = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('ancestry-lens-family-tree', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('tree');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); this.database = undefined; };
          resolve(db);
        };
      }).catch(error => { this.database = undefined; throw error; });
    }
    return this.database;
  }

  async loadFamilyTree(): Promise<FamilyTreeData> {
    const db = await this.open();
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = db.transaction('tree', 'readonly');
      const request = transaction.objectStore('tree').get('familyTree');
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not load the family tree.'));
      transaction.onerror = () => {};
    });
    return value === undefined ? emptyFamilyTree() : validateFamilyTree(value);
  }

  async saveFamilyTree(tree: FamilyTreeData): Promise<void> {
    const value = validateFamilyTree(tree);
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('tree', 'readwrite');
      transaction.objectStore('tree').put(value, 'familyTree');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('Could not save the family tree.'));
      transaction.onerror = () => {};
    });
  }
}
