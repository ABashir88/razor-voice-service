"""
Entity Memory — Track entities from responses for follow-up resolution
"""
from dataclasses import dataclass, field
from typing import Optional
import re

@dataclass
class TrackedEntity:
    name: str
    type: str  # person, company, deal
    position: int  # 1st, 2nd, etc in list
    metadata: dict = field(default_factory=dict)

class EntityMemory:
    def __init__(self):
        self.entities: list[TrackedEntity] = []
        self.last_action: Optional[str] = None
        self.last_response: Optional[str] = None
    
    def clear(self):
        self.entities = []
        self.last_action = None
        self.last_response = None
    
    def store_from_response(self, action: str, response_text: str, raw_data: dict = None):
        """Extract and store entities from a response."""
        self.last_action = action
        self.last_response = response_text
        self.entities = []
        
        # Extract names from common patterns
        if action in ("get_hot_leads", "get_email_opens", "get_email_clicks", "get_replies"):
            # Pattern: "including Name1, Name2, Name3"
            match = re.search(r'including\s+(.+?)(?:\.|$)', response_text)
            if match:
                names = [n.strip() for n in match.group(1).split(',')]
                for i, name in enumerate(names):
                    self.entities.append(TrackedEntity(
                        name=name, type="person", position=i+1
                    ))
        
        elif action == "get_pipeline":
            # Store deal info if available
            if raw_data and "deals" in raw_data:
                for i, deal in enumerate(raw_data["deals"][:5]):
                    self.entities.append(TrackedEntity(
                        name=deal.get("name", ""),
                        type="deal",
                        position=i+1,
                        metadata=deal
                    ))
        
        elif action == "get_stale_deals":
            match = re.search(r'including\s+(.+?)(?:\.|$)', response_text)
            if match:
                names = [n.strip() for n in match.group(1).split(',')]
                for i, name in enumerate(names):
                    self.entities.append(TrackedEntity(
                        name=name, type="deal", position=i+1
                    ))
        
        elif action == "lookup_contact":
            # First result is primary
            match = re.search(r'^([^,]+)', response_text)
            if match:
                self.entities.append(TrackedEntity(
                    name=match.group(1).strip(), type="person", position=1
                ))
    
    def resolve_reference(self, query: str) -> Optional[TrackedEntity]:
        """Resolve 'first one', 'call her', 'that deal' to an entity."""
        q = query.lower()
        
        # Ordinal references
        ordinals = {
            "first": 1, "1st": 1, "second": 2, "2nd": 2,
            "third": 3, "3rd": 3, "fourth": 4, "4th": 4, "fifth": 5, "5th": 5
        }
        
        for word, pos in ordinals.items():
            if word in q:
                for e in self.entities:
                    if e.position == pos:
                        return e
        
        # Pronoun references (her/him/them → first person entity)
        if any(p in q for p in ["her", "him", "them", "that one", "the one"]):
            for e in self.entities:
                if e.type == "person" and e.position == 1:
                    return e
        
        # "that deal" → first deal entity
        if "that deal" in q or "the deal" in q:
            for e in self.entities:
                if e.type == "deal" and e.position == 1:
                    return e
        
        return None

# Global instance
entity_memory = EntityMemory()
