import { useId } from "react";

import {
  CARDINALITIES,
  type Cardinality,
  type ObjectType,
} from "../../../api/dataspaces";
import { CheckField, FormField, TextField } from "./formControls";
import {
  applyRelationshipNameDefaults,
  cardinalityModeExplanation,
  cardinalityModeLabel,
  type RelationshipDraft,
  relationshipPreview,
} from "./relationshipDefaults";

import "../../../styles/data-schema.css";

interface RelationshipFormProps {
  /** The object type being edited: the "source" side. */
  sourceType: ObjectType;
  /** Every type in the space; the source itself is filtered out. */
  objectTypes: readonly ObjectType[];
  draft: RelationshipDraft;
  onChange: (draft: RelationshipDraft) => void;
  disabled?: boolean;
}

/**
 * Body of the "New attribute" dialog when the type is Relation. One submit
 * creates the attribute here, the mirrored attribute on the target, and the
 * relationship between them. Default names follow the target and cardinality
 * until the operator types their own.
 */
export function RelationshipForm({
  sourceType,
  objectTypes,
  draft,
  onChange,
  disabled = false,
}: RelationshipFormProps) {
  const modeGroupName = useId();
  // A type cannot relate to itself; the store rejects it.
  const targets = objectTypes.filter((type) => type.id !== sourceType.id);
  const findTarget = (id: string) =>
    targets.find((type) => type.id === id) ?? null;
  const target = findTarget(draft.targetTypeId);

  function update(next: RelationshipDraft) {
    onChange(
      applyRelationshipNameDefaults({
        current: draft,
        next,
        source: sourceType,
        currentTarget: target,
        nextTarget: findTarget(next.targetTypeId),
      }),
    );
  }

  if (targets.length === 0) {
    return (
      <p className="data-form-hint" role="status">
        A relationship needs a second object type to link to, and an object type
        cannot link to itself. Add another object type to this space first.
      </p>
    );
  }

  return (
    <div className="data-form">
      <FormField label="Target object type" isRequired={true}>
        {({ controlId }) => (
          <select
            id={controlId}
            className="data-form-input"
            value={draft.targetTypeId}
            disabled={disabled}
            required={true}
            onChange={(event) =>
              update({ ...draft, targetTypeId: event.target.value })
            }
          >
            <option value="">Pick an object type</option>
            {targets.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <TextField
        label={`Attribute name on ${sourceType.name}`}
        value={draft.name}
        isRequired={true}
        disabled={disabled}
        autoComplete="off"
        onChange={(name) => update({ ...draft, name })}
      />
      <fieldset className="data-mode-group" disabled={disabled}>
        <legend className="data-form-label">Cardinality</legend>
        {CARDINALITIES.map((cardinality: Cardinality) => {
          const inputId = `${modeGroupName}-${cardinality}`;
          const hintId = `${inputId}-hint`;
          return (
            <div key={cardinality} className="data-mode-option">
              <input
                id={inputId}
                type="radio"
                name={modeGroupName}
                value={cardinality}
                checked={draft.cardinality === cardinality}
                aria-describedby={hintId}
                onChange={() => update({ ...draft, cardinality })}
              />
              <div className="data-form-check-text">
                <label htmlFor={inputId}>
                  {cardinalityModeLabel(cardinality)}
                </label>
                <p className="data-form-hint" id={hintId}>
                  {cardinalityModeExplanation(cardinality, sourceType, target)}
                </p>
              </div>
            </div>
          );
        })}
        <p className="data-form-hint">Cardinality cannot be changed later.</p>
      </fieldset>
      <CheckField
        label={`Also add an attribute on ${target?.name ?? "the target"}`}
        checked={draft.hasInverse}
        disabled={disabled}
        hint="It shows the same links from the other side."
        onChange={(hasInverse) => update({ ...draft, hasInverse })}
      />
      {draft.hasInverse ? (
        <TextField
          label={`Attribute name on ${target?.name ?? "the target"}`}
          value={draft.inverseName}
          isRequired={true}
          disabled={disabled}
          autoComplete="off"
          onChange={(inverseName) => update({ ...draft, inverseName })}
        />
      ) : null}
      <p className="data-relationship-preview" aria-live="polite">
        {relationshipPreview(
          sourceType,
          target,
          draft.cardinality,
          draft.hasInverse,
        )}
      </p>
    </div>
  );
}
