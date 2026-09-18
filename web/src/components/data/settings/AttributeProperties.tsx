import type { AttributeDefinition, ObjectType } from "../../../api/dataspaces";
import { OptionPill } from "../values/OptionPill";
import { cardinalityModeLabel } from "./relationshipDefaults";

import "../../../styles/data-schema.css";

interface AttributePropertiesProps {
  attribute: AttributeDefinition;
  /** Every type in the space, to name a relationship target. */
  objectTypes: readonly ObjectType[];
}

function flagLabels(attribute: AttributeDefinition): readonly string[] {
  return [
    ...(attribute.isPrimary ? ["Primary"] : []),
    ...(attribute.isRequired ? ["Required"] : []),
    ...(attribute.isUnique ? ["Unique"] : []),
    ...(attribute.isMultivalue ? ["Multiple"] : []),
  ];
}

/**
 * The Properties cell of the attributes table: flags as plain text chips,
 * then what is specific to the type. Option pills are the one place color
 * appears, because there it carries the option's meaning.
 */
export function AttributeProperties({
  attribute,
  objectTypes,
}: AttributePropertiesProps) {
  const flags = flagLabels(attribute);
  const ref = attribute.relationship;
  const target = ref
    ? objectTypes.find((type) => type.id === ref.targetTypeId)
    : undefined;
  const isEmpty =
    flags.length === 0 &&
    attribute.options.length === 0 &&
    ref === null &&
    attribute.currencyCode === null;

  if (isEmpty) return <span className="data-list-muted">None</span>;

  return (
    <span className="data-attribute-properties">
      {flags.map((flag) => (
        <span key={flag} className="data-chip">
          {flag}
        </span>
      ))}
      {attribute.currencyCode !== null ? (
        <span className="data-chip data-mono">{attribute.currencyCode}</span>
      ) : null}
      {attribute.options.map((option) => (
        <OptionPill
          key={option.id}
          option={option}
          variant={attribute.type === "status" ? "status" : "select"}
        />
      ))}
      {ref ? (
        <span className="data-attribute-relationship">
          {"-> "}
          {target ? target.namePlural : "Unknown type"} (
          {cardinalityModeLabel(ref.cardinality)})
        </span>
      ) : null}
    </span>
  );
}
