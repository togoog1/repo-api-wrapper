import type React from "react";
import type { CreateRunFormState, ModuleCatalog, ModuleEndpointCatalog, NavFolderNode, Tab } from "../types";
import { countTreeEndpoints } from "../helpers";

interface Props {
  node: NavFolderNode;
  depth: number;
  mod: ModuleCatalog;
  openFolders: Set<string>;
  toggleFolder: (key: string) => void;
  activeTab: Tab | undefined;
  formState: CreateRunFormState;
  selectedEndpoints: Set<string>;
  handleEndpointClick: (ep: ModuleEndpointCatalog, mod: ModuleCatalog, e: React.MouseEvent) => void;
  handleEndpointContextMenu: (ep: ModuleEndpointCatalog, mod: ModuleCatalog, e: React.MouseEvent) => void;
  setContextMenuEndpoint: (v: { slug: string; x: number; y: number } | null) => void;
  setFolderContextMenu: (v: { moduleSlug: string; folderPath: string[]; x: number; y: number } | null) => void;
}

export function FolderNode({
  node, depth, mod, openFolders, toggleFolder, activeTab, formState,
  selectedEndpoints, handleEndpointClick, handleEndpointContextMenu,
  setContextMenuEndpoint, setFolderContextMenu,
}: Props) {
  const isOpen = openFolders.has(node.key);
  const totalCount = countTreeEndpoints(node);
  const folderPath = node.key.split("/").slice(1);

  return (
    <div className="tree-folder" style={{ "--folder-depth": depth } as React.CSSProperties}>
      <button
        className="tree-folder-header"
        onClick={() => toggleFolder(node.key)}
        onContextMenu={(e) => {
          e.preventDefault();
          setFolderContextMenu({ moduleSlug: mod.slug, folderPath, x: e.clientX, y: e.clientY });
        }}
        type="button"
      >
        <span className={`tree-chevron ${isOpen ? "open" : ""}`}>&#9654;</span>
        <span className="tree-folder-icon">&#128194;</span>
        <span>{node.name}</span>
        <span className="tree-folder-count">{totalCount}</span>
      </button>
      {isOpen ? (
        <>
          {node.children.map((child) => (
            <FolderNode
              key={child.key}
              node={child}
              depth={depth + 1}
              mod={mod}
              openFolders={openFolders}
              toggleFolder={toggleFolder}
              activeTab={activeTab}
              formState={formState}
              selectedEndpoints={selectedEndpoints}
              handleEndpointClick={handleEndpointClick}
              handleEndpointContextMenu={handleEndpointContextMenu}
              setContextMenuEndpoint={setContextMenuEndpoint}
              setFolderContextMenu={setFolderContextMenu}
            />
          ))}
          {node.endpoints.map((ep) => (
            <button
              className={`tree-item ${selectedEndpoints.has(ep.slug) ? "multi-selected" : ""} ${activeTab?.type !== "module-config" && formState.moduleSlug === mod.slug && formState.endpointSlug === ep.slug ? "active" : ""}`}
              key={ep.slug}
              onClick={(e) => handleEndpointClick(ep, mod, e)}
              onContextMenu={(e) => handleEndpointContextMenu(ep, mod, e)}
              style={{ "--folder-depth": depth + 1 } as React.CSSProperties}
              type="button"
            >
              <span className={`tree-item-method ${ep.method.toLowerCase()}`}>
                {ep.method}
              </span>
              <span className="tree-item-label">{ep.label}</span>
              <span className="tree-item-actions">
                <span
                  className="tree-item-action"
                  title="More actions"
                  onClick={(e) => {
                    e.stopPropagation();
                    setContextMenuEndpoint({ slug: ep.slug, x: e.clientX, y: e.clientY });
                  }}
                >&hellip;</span>
              </span>
            </button>
          ))}
        </>
      ) : null}
    </div>
  );
}
